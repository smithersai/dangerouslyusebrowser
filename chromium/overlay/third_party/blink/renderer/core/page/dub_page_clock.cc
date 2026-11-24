// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "third_party/blink/renderer/core/page/dub_page_clock.h"

#include <algorithm>

#include "base/auto_reset.h"
#include "base/time/default_tick_clock.h"
#include "third_party/blink/public/platform/scheduler/web_agent_group_scheduler.h"
#include "third_party/blink/renderer/core/animation/animation_clock.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/document_lifecycle.h"
#include "third_party/blink/renderer/core/execution_context/execution_context.h"
#include "third_party/blink/renderer/core/frame/local_dom_window.h"
#include "third_party/blink/renderer/core/frame/local_frame.h"
#include "third_party/blink/renderer/core/frame/local_frame_view.h"
#include "third_party/blink/renderer/core/page/chrome_client.h"
#include "third_party/blink/renderer/core/page/page.h"
#include "third_party/blink/renderer/core/page/page_animator.h"
#include "third_party/blink/renderer/core/scheduler/dom_timer.h"
#include "third_party/blink/renderer/core/timing/dom_window_performance.h"
#include "third_party/blink/renderer/core/timing/window_performance.h"
#include "third_party/blink/renderer/core/workers/dedicated_worker_global_scope.h"
#include "third_party/blink/renderer/platform/bindings/script_state.h"
#include "third_party/blink/renderer/platform/scheduler/public/agent_group_scheduler.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-microtask-queue.h"

namespace blink {
namespace {

constexpr base::TimeDelta kDefaultFrameInterval = base::Microseconds(16667);
constexpr uint32_t kMaxStepFrames = 600;
constexpr uint32_t kMaxTimersPerStepFrame = 1000;

}  // namespace

DubClockState::DubClockState() = default;
DubClockState::~DubClockState() = default;

base::TimeTicks DubClockState::NowTicks() const {
  base::AutoLock auto_lock(lock_);
  if (frozen_) {
    return virtual_ticks_;
  }
  if (active_) {
    base::TimeTicks candidate = base::TimeTicks::Now() + resume_ticks_offset_;
    if (candidate < last_returned_ticks_) {
      candidate = last_returned_ticks_;
    }
    last_returned_ticks_ = candidate;
    return candidate;
  }
  return base::TimeTicks::Now();
}

bool DubClockState::IsFrozen() const {
  base::AutoLock auto_lock(lock_);
  return frozen_;
}

bool DubClockState::IsActive() const {
  base::AutoLock auto_lock(lock_);
  return active_;
}

bool DubClockState::IsStepping() const {
  base::AutoLock auto_lock(lock_);
  return stepping_;
}

void DubClockState::SetStepping(bool stepping) {
  base::AutoLock auto_lock(lock_);
  stepping_ = stepping;
}

bool DubClockState::GetWallTimeMillis(int64_t* out_ms) const {
  base::AutoLock auto_lock(lock_);
  if (!frozen_) {
    return false;
  }
  *out_ms = virtual_wall_time_.InMillisecondsSinceUnixEpoch();
  return true;
}

bool DubClockState::GetMonotonicTicks(base::TimeTicks* out_ticks) const {
  base::AutoLock auto_lock(lock_);
  if (frozen_) {
    *out_ticks = virtual_ticks_;
    return true;
  }
  if (active_) {
    base::TimeTicks candidate = base::TimeTicks::Now() + resume_ticks_offset_;
    if (candidate < last_returned_ticks_) {
      candidate = last_returned_ticks_;
    }
    last_returned_ticks_ = candidate;
    *out_ticks = candidate;
    return true;
  }
  return false;
}

void DubClockState::Freeze(base::Time wall_time, base::TimeTicks ticks) {
  base::AutoLock auto_lock(lock_);
  frozen_ = true;
  active_ = true;
  virtual_wall_time_ = wall_time;
  virtual_ticks_ = std::max(ticks, last_returned_ticks_);
  last_returned_ticks_ = virtual_ticks_;
  resume_ticks_offset_ = base::TimeDelta();
}

void DubClockState::AdvanceTo(base::TimeTicks target_ticks) {
  base::AutoLock auto_lock(lock_);
  if (!frozen_ || target_ticks <= virtual_ticks_) {
    return;
  }
  const base::TimeDelta delta = target_ticks - virtual_ticks_;
  virtual_ticks_ = target_ticks;
  virtual_wall_time_ += delta;
  if (virtual_ticks_ > last_returned_ticks_) {
    last_returned_ticks_ = virtual_ticks_;
  }
}

void DubClockState::Resume() {
  base::AutoLock auto_lock(lock_);
  if (!frozen_) {
    return;
  }
  const base::TimeTicks real_now = base::TimeTicks::Now();
  if (virtual_ticks_ > real_now) {
    resume_ticks_offset_ = virtual_ticks_ - real_now;
    active_ = true;
  } else {
    resume_ticks_offset_ = base::TimeDelta();
    active_ = false;
  }
  last_returned_ticks_ = std::max(last_returned_ticks_, virtual_ticks_);
  frozen_ = false;
}

// static
void DubClockState::InstallOnIsolate(v8::Isolate* isolate) {
  if (isolate) {
    isolate->SetDubClockTimeMillisCallback(&DubClockState::V8ClockTimeMillisCallback);
  }
}

// static
bool DubClockState::V8ClockTimeMillisCallback(v8::Isolate* isolate,
                                              int64_t* out_time_ms) {
  if (!isolate || !isolate->InContext()) {
    return false;
  }
  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  if (ctx.IsEmpty()) {
    return false;
  }
  ScriptState* script_state = ScriptState::MaybeFrom(isolate, ctx);
  if (!script_state) {
    return false;
  }
  ExecutionContext* ec = ExecutionContext::From(script_state);
  DubClockState* state = DubPageClock::StateForContext(ec);
  return state ? state->GetWallTimeMillis(out_time_ms) : false;
}

DubPageClock::VirtualTimerEntry::VirtualTimerEntry(DOMTimer* t,
                                                   base::TimeTicks due,
                                                   base::TimeDelta iv,
                                                   bool single,
                                                   uint64_t ord)
    : timer(t), due_time(due), interval(iv), single_shot(single), order(ord) {}

void DubPageClock::VirtualTimerEntry::Trace(Visitor* visitor) const {
  visitor->Trace(timer);
}

DubPageClock::DubPageClock(Page& page)
    : page_(page), state_(base::MakeRefCounted<DubClockState>()) {}

DubPageClock::~DubPageClock() = default;

void DubPageClock::Trace(Visitor* visitor) const {
  visitor->Trace(page_);
  visitor->Trace(all_timers_);
  visitor->Trace(virtual_timers_);
}

void DubPageClock::DetachFromPage() {
  SyncAnimationClocks(base::TimeTicks::Now(), /*restore_default=*/true);
  virtual_timers_.clear();
  all_timers_.clear();
}

// static
DubPageClock* DubPageClock::ForContext(ExecutionContext* context) {
  if (!context) {
    return nullptr;
  }
  if (auto* window = DynamicTo<LocalDOMWindow>(context)) {
    if (LocalFrame* frame = window->GetFrame()) {
      if (Page* page = frame->GetPage()) {
        return page->GetDubClock();
      }
    }
  }
  return nullptr;
}

// static
DubClockState* DubPageClock::StateForContext(ExecutionContext* context) {
  if (!context) {
    return nullptr;
  }
  if (DubPageClock* page_clock = ForContext(context)) {
    return page_clock->State();
  }
  if (auto* worker = DynamicTo<DedicatedWorkerGlobalScope>(context)) {
    return worker->GetDubClockState();
  }
  return nullptr;
}

bool DubPageClock::OnTimerCreated(DOMTimer* timer,
                                  base::TimeDelta timeout,
                                  bool single_shot) {
  if (!timer) {
    return false;
  }
  all_timers_.insert(timer);
  if (!IsFrozen()) {
    return false;
  }
  const base::TimeDelta delay = std::max(base::TimeDelta(), timeout);
  virtual_timers_.push_back(MakeGarbageCollected<VirtualTimerEntry>(
      timer, state_->NowTicks() + delay, delay, single_shot,
      next_timer_order_++));
  return true;
}

void DubPageClock::OnTimerStopped(DOMTimer* timer) {
  if (!timer) {
    return;
  }
  all_timers_.erase(timer);
  for (wtf_size_t i = virtual_timers_.size(); i > 0; --i) {
    if (!virtual_timers_[i - 1]->timer ||
        virtual_timers_[i - 1]->timer.Get() == timer) {
      virtual_timers_.EraseAt(i - 1);
    }
  }
}

void DubPageClock::AttachDocumentClock(Document* document) {
  if (!document || !state_->IsActive()) {
    return;
  }
  document->GetAnimationClock().OverrideDynamicClockForTesting(state_.get());
  document->GetAnimationClock().UpdateTime(state_->NowTicks());
}

void DubPageClock::SyncAnimationClocks(base::TimeTicks ticks,
                                       bool restore_default) {
  if (!page_) {
    return;
  }
  const base::TickClock* target_clock =
      restore_default
          ? static_cast<const base::TickClock*>(
                base::DefaultTickClock::GetInstance())
          : static_cast<const base::TickClock*>(state_.get());
  page_->Animator().Clock().OverrideDynamicClockForTesting(target_clock);
  if (!restore_default) {
    page_->Animator().Clock().UpdateTime(ticks);
  }
  for (Frame* frame = page_->MainFrame(); frame;
       frame = frame->Tree().TraverseNext()) {
    if (auto* local_frame = DynamicTo<LocalFrame>(frame)) {
      if (Document* doc = local_frame->GetDocument()) {
        doc->GetAnimationClock().OverrideDynamicClockForTesting(target_clock);
        if (!restore_default) {
          doc->GetAnimationClock().UpdateTime(ticks);
        }
      }
    }
  }
}

void DubPageClock::RunMicrotasks() {
  if (!page_) {
    return;
  }
  v8::Isolate* isolate = page_->GetAgentGroupScheduler().Isolate();
  if (!isolate) {
    return;
  }
  for (Frame* frame = page_->MainFrame(); frame;
       frame = frame->Tree().TraverseNext()) {
    if (auto* local_frame = DynamicTo<LocalFrame>(frame)) {
      if (auto* window = local_frame->DomWindow()) {
        v8::HandleScope hs(isolate);
        if (auto* script_state = ToScriptStateForMainWorld(local_frame)) {
          v8::Local<v8::Context> ctx = script_state->GetContext();
          if (!ctx.IsEmpty()) {
            if (auto* mq = ctx->GetMicrotaskQueue()) {
              mq->PerformCheckpoint(isolate);
            }
          }
        }
        (void)window;
      }
    }
  }
}

void DubPageClock::CommitVisualUpdate() {
  if (!page_) {
    return;
  }
  if (auto* main_local = DynamicTo<LocalFrame>(page_->MainFrame())) {
    page_->Animator().UpdateAllLifecyclePhases(
        *main_local, DocumentUpdateReason::kTest);
    page_->GetChromeClient().ScheduleAnimation(main_local->View(),
                                               base::TimeDelta(),
                                               /*urgent=*/true);
  }
}

double DubPageClock::MainFramePerformanceNow() const {
  if (!page_) {
    return 0.0;
  }
  if (auto* main_local = DynamicTo<LocalFrame>(page_->MainFrame())) {
    if (auto* window = main_local->DomWindow()) {
      if (auto* perf = DOMWindowPerformance::performance(*window)) {
        return perf->now();
      }
    }
  }
  return 0.0;
}

void DubPageClock::DrainDueTimers(base::TimeTicks target_ticks,
                                  uint32_t max_fires,
                                  uint32_t* out_fired,
                                  bool* out_capped) {
  uint32_t fired = 0;
  bool capped = false;

  while (true) {
    // Prune dead/stopped entries and pick the earliest due entry <= target_ticks.
    wtf_size_t best_idx = kNotFound;
    for (wtf_size_t i = virtual_timers_.size(); i > 0; --i) {
      VirtualTimerEntry* entry = virtual_timers_[i - 1];
      if (!entry || !entry->timer || !entry->timer->IsDubVirtualManaged()) {
        virtual_timers_.EraseAt(i - 1);
        continue;
      }
      if (entry->due_time > target_ticks) {
        continue;
      }
      if (best_idx == kNotFound ||
          entry->due_time < virtual_timers_[best_idx]->due_time ||
          (entry->due_time == virtual_timers_[best_idx]->due_time &&
           entry->order < virtual_timers_[best_idx]->order)) {
        best_idx = i - 1;
      }
    }

    if (best_idx == kNotFound) {
      break;
    }
    if (fired >= max_fires) {
      capped = true;
      // Fast-forward remaining overdue repeating timers past target_ticks so
      // an infinite short interval cannot hang subsequent operations.
      for (VirtualTimerEntry* entry : virtual_timers_) {
        if (entry && entry->timer && entry->due_time <= target_ticks) {
          if (!entry->single_shot) {
            const base::TimeDelta step =
                std::max(entry->interval, base::Milliseconds(1));
            entry->due_time = target_ticks + step;
          }
        }
      }
      break;
    }

    VirtualTimerEntry* entry = virtual_timers_[best_idx];
    DOMTimer* timer = entry->timer.Get();
    const base::TimeTicks fire_time = entry->due_time;
    const bool single_shot = entry->single_shot;

    if (single_shot) {
      virtual_timers_.EraseAt(best_idx);
    } else {
      const base::TimeDelta step =
          std::max(entry->interval, base::Milliseconds(1));
      entry->due_time = fire_time + step;
      entry->order = next_timer_order_++;
    }

    state_->AdvanceTo(fire_time);
    ++fired;
    if (timer) {
      timer->FireFromDubClock();
      RunMicrotasks();
    }
  }

  state_->AdvanceTo(target_ticks);
  *out_fired = fired;
  *out_capped = capped;
}

DubClockSnapshot DubPageClock::Freeze(int64_t epoch_ms) {
  DubClockSnapshot snap;
  if (!page_) {
    snap.ok = false;
    snap.error_code = "PAGE_GONE";
    snap.error_message = "Page is no longer available";
    return snap;
  }

  DubClockState::InstallOnIsolate(page_->GetAgentGroupScheduler().Isolate());

  const base::Time wall_time =
      base::Time::FromMillisecondsSinceUnixEpoch(epoch_ms);
  const base::TimeTicks anim_now = page_->Animator().Clock().CurrentTime();
  const base::TimeTicks base_ticks =
      std::max({base::TimeTicks::Now(), anim_now, state_->NowTicks()});

  const bool was_frozen = state_->IsFrozen();
  state_->Freeze(wall_time, base_ticks);
  SyncAnimationClocks(state_->NowTicks(), /*restore_default=*/false);

  // Adopt any pre-existing live DOMTimers created before Freeze().
  if (!was_frozen) {
    HeapVector<Member<DOMTimer>> existing;
    for (const auto& weak_timer : all_timers_) {
      if (DOMTimer* t = weak_timer.Get()) {
        existing.push_back(t);
      }
    }
    for (DOMTimer* t : existing) {
      base::TimeDelta remaining;
      base::TimeDelta interval;
      bool single_shot = true;
      if (t->AdoptIntoDubClock(&remaining, &interval, &single_shot)) {
        virtual_timers_.push_back(MakeGarbageCollected<VirtualTimerEntry>(
            t, state_->NowTicks() + std::max(base::TimeDelta(), remaining),
            interval, single_shot, next_timer_order_++));
      }
    }
  }

  snap.ok = true;
  snap.frozen = true;
  state_->GetWallTimeMillis(&snap.epoch_ms);
  snap.performance_now_ms = MainFramePerformanceNow();
  return snap;
}

DubClockSnapshot DubPageClock::Advance(int64_t delta_ms, uint32_t max_fires) {
  DubClockSnapshot snap;
  if (!state_->IsFrozen()) {
    snap.ok = false;
    snap.error_code = "CLOCK_NOT_FROZEN";
    snap.error_message = "Call clock.freeze before clock.advance";
    return snap;
  }
  if (delta_ms < 0) {
    snap.ok = false;
    snap.error_code = "INVALID_PARAMS";
    snap.error_message = "Advance delta must be non-negative";
    return snap;
  }

  const base::TimeTicks target_ticks =
      state_->NowTicks() + base::Milliseconds(delta_ms);
  DrainDueTimers(target_ticks, max_fires, &snap.timers_fired,
                 &snap.timers_capped);

  // Update animation clock to target_ticks and refresh layout/animations so
  // CSS animations and timer-driven DOM updates reflect the new virtual instant.
  SyncAnimationClocks(state_->NowTicks(), /*restore_default=*/false);
  if (page_) {
    state_->SetStepping(true);
    page_->Animator().ServiceScriptedAnimations(state_->NowTicks());
    state_->SetStepping(false);
    RunMicrotasks();
    CommitVisualUpdate();
  }

  snap.ok = true;
  snap.frozen = true;
  state_->GetWallTimeMillis(&snap.epoch_ms);
  snap.performance_now_ms = MainFramePerformanceNow();
  return snap;
}

DubClockSnapshot DubPageClock::StepFrames(uint32_t frames) {
  DubClockSnapshot snap;
  if (!state_->IsFrozen()) {
    snap.ok = false;
    snap.error_code = "CLOCK_NOT_FROZEN";
    snap.error_message = "Call clock.freeze before clock.step";
    return snap;
  }
  if (frames == 0 || frames > kMaxStepFrames) {
    snap.ok = false;
    snap.error_code = "INVALID_PARAMS";
    snap.error_message = "frames must be between 1 and 600";
    return snap;
  }

  uint32_t total_fired = 0;
  bool any_capped = false;
  for (uint32_t i = 0; i < frames; ++i) {
    const base::TimeTicks next_frame_ticks =
        state_->NowTicks() + kDefaultFrameInterval;
    uint32_t frame_fired = 0;
    bool frame_capped = false;
    DrainDueTimers(next_frame_ticks, kMaxTimersPerStepFrame, &frame_fired,
                   &frame_capped);
    total_fired += frame_fired;
    any_capped = any_capped || frame_capped;

    SyncAnimationClocks(state_->NowTicks(), /*restore_default=*/false);
    if (page_) {
      state_->SetStepping(true);
      page_->Animator().ServiceScriptedAnimations(state_->NowTicks());
      state_->SetStepping(false);
      RunMicrotasks();
      if (auto* main_local = DynamicTo<LocalFrame>(page_->MainFrame())) {
        page_->Animator().UpdateAllLifecyclePhases(
            *main_local, DocumentUpdateReason::kTest);
      }
    }
  }
  CommitVisualUpdate();

  snap.ok = true;
  snap.frozen = true;
  state_->GetWallTimeMillis(&snap.epoch_ms);
  snap.performance_now_ms = MainFramePerformanceNow();
  snap.timers_fired = total_fired;
  snap.timers_capped = any_capped;
  snap.frames_stepped = frames;
  return snap;
}

DubClockSnapshot DubPageClock::Resume() {
  DubClockSnapshot snap;
  const base::TimeTicks now_before_resume = state_->NowTicks();
  state_->Resume();

  // Re-arm remaining virtual timers onto Blink's real TimerBase with their
  // remaining virtual delay.
  HeapVector<Member<VirtualTimerEntry>> remaining = std::move(virtual_timers_);
  virtual_timers_.clear();
  for (VirtualTimerEntry* entry : remaining) {
    if (entry && entry->timer && entry->timer->IsDubVirtualManaged()) {
      const base::TimeDelta delay =
          std::max(base::TimeDelta(), entry->due_time - now_before_resume);
      entry->timer->ReleaseFromDubClock(delay);
    }
  }

  SyncAnimationClocks(state_->NowTicks(),
                      /*restore_default=*/!state_->IsActive());
  CommitVisualUpdate();

  snap.ok = true;
  snap.frozen = false;
  snap.epoch_ms = base::Time::Now().InMillisecondsSinceUnixEpoch();
  snap.performance_now_ms = MainFramePerformanceNow();
  return snap;
}

}  // namespace blink
