// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef THIRD_PARTY_BLINK_RENDERER_CORE_PAGE_DUB_PAGE_CLOCK_H_
#define THIRD_PARTY_BLINK_RENDERER_CORE_PAGE_DUB_PAGE_CLOCK_H_

#include <cstdint>
#include <string>

#include "base/memory/ref_counted.h"
#include "base/synchronization/lock.h"
#include "base/time/tick_clock.h"
#include "base/time/time.h"
#include "third_party/blink/renderer/core/core_export.h"
#include "third_party/blink/renderer/platform/heap/collection_support/heap_hash_set.h"
#include "third_party/blink/renderer/platform/heap/collection_support/heap_vector.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/heap/member.h"

namespace v8 {
class Isolate;
}

namespace blink {

class DOMTimer;
class ExecutionContext;
class Page;

struct CORE_EXPORT DubClockSnapshot {
  bool ok = true;
  bool frozen = false;
  int64_t epoch_ms = 0;
  double performance_now_ms = 0.0;
  uint32_t timers_fired = 0;
  bool timers_capped = false;
  uint32_t frames_stepped = 0;
  std::string error_code;
  std::string error_message;
};

// Thread-safe per-page clock domain state shared between a blink::Page and any
// DedicatedWorkers spawned from it. Implements base::TickClock so Blink's
// AnimationClock can read it directly.
class CORE_EXPORT DubClockState final
    : public base::RefCountedThreadSafe<DubClockState>,
      public base::TickClock {
 public:
  DubClockState();

  // base::TickClock:
  base::TimeTicks NowTicks() const override;

  bool IsFrozen() const;
  bool IsActive() const;
  bool IsStepping() const;
  void SetStepping(bool stepping);

  // Returns true and writes virtual epoch milliseconds when frozen.
  bool GetWallTimeMillis(int64_t* out_ms) const;

  // Returns true and writes virtual/offset monotonic ticks when active.
  bool GetMonotonicTicks(base::TimeTicks* out_ticks) const;

  void Freeze(base::Time wall_time, base::TimeTicks ticks);
  void AdvanceTo(base::TimeTicks target_ticks);
  void Resume();

  static void InstallOnIsolate(v8::Isolate* isolate);
  static bool V8ClockTimeMillisCallback(v8::Isolate* isolate,
                                        int64_t* out_time_ms);

 private:
  friend class base::RefCountedThreadSafe<DubClockState>;
  ~DubClockState() override;

  mutable base::Lock lock_;
  bool frozen_ = false;
  bool active_ = false;
  bool stepping_ = false;
  base::Time virtual_wall_time_;
  base::TimeTicks virtual_ticks_;
  base::TimeDelta resume_ticks_offset_;
  mutable base::TimeTicks last_returned_ticks_;
};

// Oilpan-managed virtual clock controller owned by each blink::Page.
class CORE_EXPORT DubPageClock final : public GarbageCollected<DubPageClock> {
 public:
  class VirtualTimerEntry final : public GarbageCollected<VirtualTimerEntry> {
   public:
    VirtualTimerEntry(DOMTimer* timer,
                      base::TimeTicks due_time,
                      base::TimeDelta interval,
                      bool single_shot,
                      uint64_t order);
    void Trace(Visitor* visitor) const;

    WeakMember<DOMTimer> timer;
    base::TimeTicks due_time;
    base::TimeDelta interval;
    bool single_shot = true;
    uint64_t order = 0;
  };

  explicit DubPageClock(Page& page);
  ~DubPageClock();

  void Trace(Visitor* visitor) const;
  void DetachFromPage();

  DubClockState* State() const { return state_.get(); }
  scoped_refptr<DubClockState> SharedState() const { return state_; }

  bool IsFrozen() const { return state_->IsFrozen(); }
  bool IsStepping() const { return state_->IsStepping(); }
  base::TimeTicks NowTicks() const { return state_->NowTicks(); }

  static DubPageClock* ForContext(ExecutionContext* context);
  static DubClockState* StateForContext(ExecutionContext* context);

  // Called by DOMTimer when constructed and stopped. Returns true if the timer
  // was captured into this page's virtual timer queue (caller should not arm
  // TimerBase).
  bool OnTimerCreated(DOMTimer* timer,
                      base::TimeDelta timeout,
                      bool single_shot);
  void OnTimerStopped(DOMTimer* timer);

  // Called when a Document attaches to a frozen page.
  void AttachDocumentClock(class Document* document);

  DubClockSnapshot Freeze(int64_t epoch_ms);
  DubClockSnapshot Advance(int64_t delta_ms, uint32_t max_fires = 10000);
  DubClockSnapshot StepFrames(uint32_t frames);
  DubClockSnapshot Resume();

 private:
  void SyncAnimationClocks(base::TimeTicks ticks, bool restore_default);
  void DrainDueTimers(base::TimeTicks target_ticks,
                      uint32_t max_fires,
                      uint32_t* out_fired,
                      bool* out_capped);
  void RunMicrotasks();
  void CommitVisualUpdate();
  double MainFramePerformanceNow() const;

  Member<Page> page_;
  scoped_refptr<DubClockState> state_;
  HeapHashSet<WeakMember<DOMTimer>> all_timers_;
  HeapVector<Member<VirtualTimerEntry>> virtual_timers_;
  uint64_t next_timer_order_ = 1;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_CORE_PAGE_DUB_PAGE_CLOCK_H_
