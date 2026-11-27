// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_browser_state.h"

#include <algorithm>
#include <utility>

#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "chrome/browser/download/download_prefs.h"
#include "chrome/browser/dub/dub_events.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/mojom/devtools/console_message.mojom.h"

namespace dub {
namespace {

constexpr size_t kMaxConsoleEntries = 500;

int GetTabId(content::WebContents* contents) {
  if (!contents) {
    return 0;
  }
  auto* tab = tabs::TabInterface::GetFromContents(contents);
  return tab ? tab->GetHandle().raw_value() : 0;
}

std::string ConsoleLevelName(blink::mojom::ConsoleMessageLevel level) {
  switch (level) {
    case blink::mojom::ConsoleMessageLevel::kVerbose:
      return "debug";
    case blink::mojom::ConsoleMessageLevel::kInfo:
      return "info";
    case blink::mojom::ConsoleMessageLevel::kWarning:
      return "warning";
    case blink::mojom::ConsoleMessageLevel::kError:
      return "error";
  }
  return "info";
}

std::string DialogTypeName(content::JavaScriptDialogType type) {
  switch (type) {
    case content::JAVASCRIPT_DIALOG_TYPE_ALERT:
      return "alert";
    case content::JAVASCRIPT_DIALOG_TYPE_CONFIRM:
      return "confirm";
    case content::JAVASCRIPT_DIALOG_TYPE_PROMPT:
      return "prompt";
  }
  return "alert";
}

std::string DownloadStateName(download::DownloadItem::DownloadState state) {
  switch (state) {
    case download::DownloadItem::IN_PROGRESS:
      return "in_progress";
    case download::DownloadItem::COMPLETE:
      return "complete";
    case download::DownloadItem::CANCELLED:
      return "cancelled";
    case download::DownloadItem::INTERRUPTED:
      return "interrupted";
    case download::DownloadItem::MAX_DOWNLOAD_STATE:
      return "unknown";
  }
  return "unknown";
}

}  // namespace

content::JavaScriptDialogManager* GetDialogManagerIfEnabled(
    content::WebContents* contents) {
  if (!contents) {
    return nullptr;
  }
  auto& mgr = DubDialogManager::GetInstance();
  return mgr.IsEnabled() ? &mgr : nullptr;
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(DubTabObserver);

// static
DubTabObserver* DubTabObserver::EnsureForWebContents(
    content::WebContents* contents) {
  if (!contents) {
    return nullptr;
  }
  CreateForWebContents(contents);
  return FromWebContents(contents);
}

DubTabObserver::DubTabObserver(content::WebContents* contents)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<DubTabObserver>(*contents) {
  contents->ForEachRenderFrameHost(
      [this](content::RenderFrameHost* rfh) { SyncFrameScripts(rfh); });
}

DubTabObserver::~DubTabObserver() {
  nav_waiters_.clear();
}

base::DictValue DubTabObserver::ReadConsole(uint64_t since,
                                            const std::string& level_filter,
                                            bool clear) {
  base::ListValue entries;
  for (const auto& e : console_entries_) {
    if (e.seq <= since) {
      continue;
    }
    if (!level_filter.empty() && level_filter != "all" &&
        e.level != level_filter) {
      continue;
    }
    base::DictValue d;
    d.Set("seq", static_cast<int>(e.seq));
    d.Set("timestampMs", static_cast<double>(e.timestamp_ms));
    d.Set("level", e.level);
    d.Set("message", e.message);
    d.Set("source", e.source);
    d.Set("line", e.line);
    d.Set("frameId", e.frame_id);
    entries.Append(std::move(d));
  }
  const uint64_t next_seq = next_console_seq_ > 1 ? next_console_seq_ - 1 : 0;
  if (clear) {
    console_entries_.clear();
  }
  base::DictValue out;
  out.Set("tab", GetTabId(web_contents()));
  out.Set("nextSeq", static_cast<int>(next_seq));
  out.Set("entries", std::move(entries));
  return out;
}

void DubTabObserver::AddNavigationWaiter(const std::string& wait_until,
                                         base::OnceClosure callback) {
  nav_waiters_.push_back({wait_until, std::move(callback)});
}

void DubTabObserver::FireWaiters(const std::string& stage) {
  std::vector<base::OnceClosure> to_run;
  auto it = nav_waiters_.begin();
  while (it != nav_waiters_.end()) {
    bool match = (it->wait_until == stage);
    if (stage == "networkidle" && it->wait_until == "load") {
      match = true;
    }
    if (match) {
      to_run.push_back(std::move(it->callback));
      it = nav_waiters_.erase(it);
    } else {
      ++it;
    }
  }
  for (auto& cb : to_run) {
    if (cb) {
      std::move(cb).Run();
    }
  }
}

void DubTabObserver::SyncFrameScripts(content::RenderFrameHost* rfh) {
  if (rfh && rfh->IsRenderFrameLive()) {
    DubScriptRegistry::GetInstance().SyncToFrame(rfh);
  }
}

void DubTabObserver::RenderFrameCreated(content::RenderFrameHost* rfh) {
  SyncFrameScripts(rfh);
}

void DubTabObserver::ReadyToCommitNavigation(
    content::NavigationHandle* handle) {
  if (handle && handle->GetRenderFrameHost()) {
    SyncFrameScripts(handle->GetRenderFrameHost());
  }
}

void DubTabObserver::DidFinishNavigation(content::NavigationHandle* handle) {
  if (!handle || !handle->HasCommitted() || !handle->IsInPrimaryMainFrame()) {
    return;
  }
  SyncFrameScripts(handle->GetRenderFrameHost());
  base::DictValue ev;
  ev.Set("tab", GetTabId(web_contents()));
  ev.Set("url", handle->GetURL().spec());
  ev.Set("isSameDocument", handle->IsSameDocument());
  DubEventHub::GetInstance().EmitEvent("tab.navigated", std::move(ev));
  FireWaiters("commit");
  if (handle->IsSameDocument()) {
    FireWaiters("domcontentloaded");
    FireWaiters("load");
    FireWaiters("networkidle");
  }
}

void DubTabObserver::DOMContentLoaded(content::RenderFrameHost* rfh) {
  if (rfh && rfh->IsInPrimaryMainFrame()) {
    FireWaiters("domcontentloaded");
  }
}

void DubTabObserver::DidFinishLoad(content::RenderFrameHost* rfh,
                                   const GURL& validated_url) {
  if (!rfh || !rfh->IsInPrimaryMainFrame()) {
    return;
  }
  base::DictValue ev;
  ev.Set("tab", GetTabId(web_contents()));
  ev.Set("url", validated_url.spec());
  ev.Set("title", base::UTF16ToUTF8(web_contents()->GetTitle()));
  DubEventHub::GetInstance().EmitEvent("tab.loaded", std::move(ev));
  FireWaiters("load");
}

void DubTabObserver::DidStopLoading() {
  FireWaiters("networkidle");
}

void DubTabObserver::OnDidAddMessageToConsole(
    content::RenderFrameHost* source_frame,
    blink::mojom::ConsoleMessageLevel log_level,
    const std::u16string& message,
    int32_t line_no,
    const std::u16string& source_id,
    const std::optional<std::u16string>& untrusted_stack_trace) {
  ConsoleEntry entry;
  entry.seq = next_console_seq_++;
  entry.timestamp_ms = base::Time::Now().InMillisecondsSinceUnixEpoch();
  entry.level = ConsoleLevelName(log_level);
  entry.message = base::UTF16ToUTF8(message);
  entry.source = base::UTF16ToUTF8(source_id);
  entry.line = line_no;
  if (source_frame) {
    auto fid = source_frame->GetGlobalId();
    entry.frame_id = base::NumberToString(fid.child_id.GetUnsafeValue()) + ":" +
                     base::NumberToString(fid.frame_routing_id);
  }
  console_entries_.push_back(entry);
  while (console_entries_.size() > kMaxConsoleEntries) {
    console_entries_.pop_front();
  }

  base::DictValue ev;
  ev.Set("tab", GetTabId(web_contents()));
  ev.Set("seq", static_cast<int>(entry.seq));
  ev.Set("level", entry.level);
  ev.Set("message", entry.message);
  ev.Set("source", entry.source);
  ev.Set("line", entry.line);
  ev.Set("frameId", entry.frame_id);
  DubEventHub::GetInstance().EmitEvent(
      entry.level == "error" ? "page.error" : "page.console", std::move(ev));
}

void DubTabObserver::WebContentsDestroyed() {
  auto waiters = std::move(nav_waiters_);
  nav_waiters_.clear();
  for (auto& w : waiters) {
    if (w.callback) {
      std::move(w.callback).Run();
    }
  }
}

// --- DubDialogManager ---

DubDialogManager::DubDialogManager() = default;
DubDialogManager::~DubDialogManager() = default;

DubDialogManager& DubDialogManager::GetInstance() {
  static base::NoDestructor<DubDialogManager> instance;
  return *instance;
}

base::DictValue DubDialogManager::SetPolicy(const base::DictValue& params,
                                            std::string* error) {
  const std::string* mode = params.FindString("mode");
  if (!mode || (*mode != "default" && *mode != "auto_accept" &&
                *mode != "auto_dismiss" && *mode != "callback")) {
    *error = "mode must be one of default, auto_accept, auto_dismiss, callback";
    return base::DictValue();
  }
  mode_ = *mode;
  if (const std::string* prompt = params.FindString("promptText")) {
    default_prompt_text_ = *prompt;
  }
  if (auto timeout = params.FindInt("timeoutMs")) {
    callback_timeout_ms_ = std::clamp(*timeout, 500, 120000);
  }
  return GetPolicy();
}

base::DictValue DubDialogManager::GetPolicy() const {
  base::DictValue out;
  out.Set("mode", mode_);
  out.Set("promptText", default_prompt_text_);
  out.Set("timeoutMs", callback_timeout_ms_);
  return out;
}

base::DictValue DubDialogManager::ListDialogs() const {
  base::ListValue list;
  for (const auto& d : pending_) {
    base::DictValue item;
    item.Set("id", d->id);
    item.Set("callbackId", d->callback_id);
    item.Set("tab", d->tab_id);
    item.Set("type", d->type);
    item.Set("message", d->message);
    item.Set("defaultPrompt", d->default_prompt);
    list.Append(std::move(item));
  }
  base::DictValue out;
  out.Set("policy", GetPolicy());
  out.Set("dialogs", std::move(list));
  return out;
}

bool DubDialogManager::RespondDialog(const std::string& id,
                                     bool accept,
                                     const std::string& prompt_text) {
  auto it = std::find_if(pending_.begin(), pending_.end(),
                         [&](const auto& d) { return d->id == id; });
  if (it == pending_.end()) {
    return false;
  }
  FinishDialog(id, accept, prompt_text);
  return true;
}

void DubDialogManager::FinishDialog(const std::string& id,
                                    bool accept,
                                    const std::string& prompt_text) {
  auto it = std::find_if(pending_.begin(), pending_.end(),
                         [&](const auto& d) { return d->id == id; });
  if (it == pending_.end()) {
    return;
  }
  auto entry = std::move(*it);
  pending_.erase(it);
  if (entry->callback) {
    std::move(entry->callback).Run(accept, base::UTF8ToUTF16(prompt_text));
  }
}

void DubDialogManager::RunJavaScriptDialog(
    content::WebContents* web_contents,
    content::RenderFrameHost* render_frame_host,
    content::JavaScriptDialogType dialog_type,
    const std::u16string& message_text,
    const std::u16string& default_prompt_text,
    DialogClosedCallback callback,
    bool* did_suppress_message) {
  const std::string type_str = DialogTypeName(dialog_type);
  const std::string msg_str = base::UTF16ToUTF8(message_text);
  const std::string def_str = base::UTF16ToUTF8(default_prompt_text);
  const int tab_id = GetTabId(web_contents);

  base::DictValue ev;
  ev.Set("tab", tab_id);
  ev.Set("type", type_str);
  ev.Set("message", msg_str);
  ev.Set("defaultPrompt", def_str);
  ev.Set("mode", mode_);
  DubEventHub::GetInstance().EmitEvent("page.dialog", ev.Clone());

  if (mode_ == "auto_accept") {
    const std::string reply_text =
        default_prompt_text_.empty() ? def_str : default_prompt_text_;
    std::move(callback).Run(true, base::UTF8ToUTF16(reply_text));
    return;
  }
  if (mode_ == "auto_dismiss") {
    std::move(callback).Run(false, std::u16string());
    return;
  }

  auto entry = std::make_unique<PendingDialog>();
  entry->id = "dlg-" + base::NumberToString(next_dialog_id_++);
  entry->tab_id = tab_id;
  entry->type = type_str;
  entry->message = msg_str;
  entry->default_prompt = def_str;
  entry->web_contents = web_contents;
  entry->callback = std::move(callback);

  const std::string dlg_id = entry->id;
  ev.Set("id", dlg_id);
  entry->callback_id = DubEventHub::GetInstance().InvokeCallback(
      "dialog", std::move(ev), callback_timeout_ms_,
      base::BindOnce(
          [](base::WeakPtr<DubDialogManager> self, std::string id,
             std::string fallback_prompt,
             std::optional<base::DictValue> decision) {
            if (!self) {
              return;
            }
            if (!decision) {
              self->FinishDialog(id, false, "");
              return;
            }
            const bool accept = decision->FindBool("accept").value_or(true);
            const std::string* prompt = decision->FindString("promptText");
            self->FinishDialog(id, accept, prompt ? *prompt : fallback_prompt);
          },
          weak_factory_.GetWeakPtr(), dlg_id, def_str));
  pending_.push_back(std::move(entry));
}

void DubDialogManager::RunBeforeUnloadDialog(
    content::WebContents* web_contents,
    content::RenderFrameHost* render_frame_host,
    bool is_reload,
    DialogClosedCallback callback) {
  const int tab_id = GetTabId(web_contents);
  base::DictValue ev;
  ev.Set("tab", tab_id);
  ev.Set("type", "beforeunload");
  ev.Set("isReload", is_reload);
  DubEventHub::GetInstance().EmitEvent("page.dialog", ev.Clone());

  if (mode_ == "auto_dismiss") {
    std::move(callback).Run(false, std::u16string());
    return;
  }
  if (mode_ == "auto_accept") {
    std::move(callback).Run(true, std::u16string());
    return;
  }

  auto entry = std::make_unique<PendingDialog>();
  entry->id = "dlg-" + base::NumberToString(next_dialog_id_++);
  entry->tab_id = tab_id;
  entry->type = "beforeunload";
  entry->web_contents = web_contents;
  entry->callback = std::move(callback);
  const std::string dlg_id = entry->id;
  ev.Set("id", dlg_id);
  entry->callback_id = DubEventHub::GetInstance().InvokeCallback(
      "dialog", std::move(ev), callback_timeout_ms_,
      base::BindOnce(
          [](base::WeakPtr<DubDialogManager> self, std::string id,
             std::optional<base::DictValue> decision) {
            if (!self) {
              return;
            }
            const bool accept =
                decision ? decision->FindBool("accept").value_or(true) : true;
            self->FinishDialog(id, accept, "");
          },
          weak_factory_.GetWeakPtr(), dlg_id));
  pending_.push_back(std::move(entry));
}

void DubDialogManager::CancelDialogs(content::WebContents* web_contents,
                                     bool reset_state) {
  auto it = pending_.begin();
  while (it != pending_.end()) {
    if ((*it)->web_contents == web_contents) {
      auto entry = std::move(*it);
      it = pending_.erase(it);
      if (entry->callback) {
        std::move(entry->callback).Run(false, std::u16string());
      }
    } else {
      ++it;
    }
  }
}

// --- DubDownloadTracker ---

DubDownloadTracker::DubDownloadTracker() = default;
DubDownloadTracker::~DubDownloadTracker() {
  if (manager_) {
    manager_->RemoveObserver(this);
  }
}

DubDownloadTracker& DubDownloadTracker::GetInstance() {
  static base::NoDestructor<DubDownloadTracker> instance;
  return *instance;
}

void DubDownloadTracker::EnsureAttached(Profile* profile) {
  if (!profile) {
    return;
  }
  auto* mgr = profile->GetDownloadManager();
  if (!mgr || mgr == manager_) {
    return;
  }
  if (manager_) {
    manager_->RemoveObserver(this);
  }
  manager_ = mgr;
  manager_->AddObserver(this);
  content::DownloadManager::DownloadVector items;
  manager_->GetAllDownloads(&items);
  for (download::DownloadItem* item : items) {
    item->AddObserver(this);
    UpdateFromItem(item);
  }
}

base::DictValue DubDownloadTracker::Configure(Profile* profile,
                                              const base::DictValue& params,
                                              std::string* error) {
  EnsureAttached(profile);
  const std::string* dir = params.FindString("directory");
  if (!dir || dir->empty()) {
    *error = "Expected non-empty directory path";
    return base::DictValue();
  }
  base::FilePath path(*dir);
  if (!path.IsAbsolute()) {
    *error = "Download directory must be an absolute path";
    return base::DictValue();
  }
  if (auto* prefs = DownloadPrefs::FromBrowserContext(profile)) {
    prefs->SetDownloadPath(path);
  }
  base::DictValue out;
  out.Set("directory", path.value());
  return out;
}

base::DictValue DubDownloadTracker::SerializeRecord(
    const DownloadRecord& r) const {
  base::DictValue d;
  d.Set("id", r.id);
  d.Set("url", r.url);
  d.Set("filename", r.filename);
  d.Set("targetPath", r.target_path);
  d.Set("mimeType", r.mime_type);
  d.Set("state", r.state);
  d.Set("receivedBytes", static_cast<double>(r.received_bytes));
  d.Set("totalBytes", static_cast<double>(r.total_bytes));
  return d;
}

base::DictValue DubDownloadTracker::ListDownloads() const {
  base::ListValue list;
  for (const auto& [k, rec] : records_) {
    list.Append(SerializeRecord(rec));
  }
  base::DictValue out;
  out.Set("downloads", std::move(list));
  return out;
}

void DubDownloadTracker::WaitForDownload(
    const std::string& id_filter,
    base::OnceCallback<void(base::DictValue)> callback) {
  for (const auto& [k, rec] : records_) {
    if ((!id_filter.empty() && rec.id != id_filter) ||
        rec.state == "in_progress") {
      continue;
    }
    if (!id_filter.empty()) {
      std::move(callback).Run(SerializeRecord(rec));
      return;
    }
  }
  waiters_.push_back({id_filter, std::move(callback)});
}

void DubDownloadTracker::UpdateFromItem(download::DownloadItem* item) {
  if (!item) {
    return;
  }
  DownloadRecord rec;
  rec.id = base::NumberToString(item->GetId());
  rec.url = item->GetURL().spec();
  rec.filename = item->GetFileNameToReportUser().value();
  rec.target_path = item->GetTargetFilePath().value();
  rec.mime_type = item->GetMimeType();
  rec.state = DownloadStateName(item->GetState());
  rec.received_bytes = item->GetReceivedBytes();
  rec.total_bytes = item->GetTotalBytes();
  records_[item->GetId()] = rec;

  base::DictValue payload = SerializeRecord(rec);
  DubEventHub::GetInstance().EmitEvent("download.updated", payload.Clone());

  if (rec.state != "in_progress") {
    auto it = waiters_.begin();
    while (it != waiters_.end()) {
      if (it->id_filter.empty() || it->id_filter == rec.id) {
        auto cb = std::move(it->callback);
        it = waiters_.erase(it);
        if (cb) {
          std::move(cb).Run(payload.Clone());
        }
      } else {
        ++it;
      }
    }
  }
}

void DubDownloadTracker::OnDownloadCreated(content::DownloadManager* manager,
                                           download::DownloadItem* item) {
  if (!item) {
    return;
  }
  item->AddObserver(this);
  UpdateFromItem(item);
}

void DubDownloadTracker::ManagerGoingDown(content::DownloadManager* manager) {
  if (manager == manager_) {
    manager_->RemoveObserver(this);
    manager_ = nullptr;
  }
}

void DubDownloadTracker::OnDownloadUpdated(download::DownloadItem* item) {
  UpdateFromItem(item);
}

void DubDownloadTracker::OnDownloadDestroyed(download::DownloadItem* item) {
  if (item) {
    item->RemoveObserver(this);
  }
}

// --- DubScriptRegistry ---

DubScriptRegistry::DubScriptRegistry() = default;
DubScriptRegistry::~DubScriptRegistry() = default;

DubScriptRegistry& DubScriptRegistry::GetInstance() {
  static base::NoDestructor<DubScriptRegistry> instance;
  return *instance;
}

base::DictValue DubScriptRegistry::AddScript(const base::DictValue& params,
                                             std::string* error) {
  const std::string* source = params.FindString("source");
  if (!source || source->empty()) {
    *error = "Expected non-empty source string";
    return base::DictValue();
  }
  ScriptRecord rec;
  if (const std::string* custom_id = params.FindString("id");
      custom_id && !custom_id->empty()) {
    rec.id = *custom_id;
  } else {
    rec.id = "script-" + base::NumberToString(next_script_id_++);
  }
  rec.match = params.FindString("match") ? *params.FindString("match") : "*";
  rec.source = *source;
  const std::string* world = params.FindString("world");
  rec.isolated_world = world && *world == "isolated";
  rec.all_frames = params.FindBool("allFrames").value_or(true);
  if (const std::string* pid = params.FindString("pluginId")) {
    rec.plugin_id = *pid;
  }

  auto it = std::find_if(scripts_.begin(), scripts_.end(),
                         [&](const auto& s) { return s.id == rec.id; });
  if (it != scripts_.end()) {
    *it = rec;
  } else {
    scripts_.push_back(rec);
  }
  SyncToAllFrames();

  base::DictValue out;
  out.Set("id", rec.id);
  out.Set("match", rec.match);
  out.Set("world", rec.isolated_world ? "isolated" : "main");
  out.Set("allFrames", rec.all_frames);
  if (!rec.plugin_id.empty()) {
    out.Set("pluginId", rec.plugin_id);
  }
  return out;
}

bool DubScriptRegistry::RemoveScript(const std::string& id) {
  auto it = std::find_if(scripts_.begin(), scripts_.end(),
                         [&](const auto& s) { return s.id == id; });
  if (it == scripts_.end()) {
    return false;
  }
  scripts_.erase(it);
  SyncToAllFrames();
  return true;
}

int DubScriptRegistry::RemoveByPlugin(const std::string& plugin_id) {
  int removed = 0;
  auto sit = std::remove_if(scripts_.begin(), scripts_.end(), [&](const auto& s) {
    if (s.plugin_id == plugin_id) {
      ++removed;
      return true;
    }
    return false;
  });
  scripts_.erase(sit, scripts_.end());

  auto eit = std::remove_if(exposed_.begin(), exposed_.end(), [&](const auto& e) {
    if (e.plugin_id == plugin_id) {
      ++removed;
      return true;
    }
    return false;
  });
  exposed_.erase(eit, exposed_.end());
  if (removed > 0) {
    SyncToAllFrames();
  }
  return removed;
}

base::DictValue DubScriptRegistry::ListScripts() const {
  base::ListValue list;
  for (const auto& s : scripts_) {
    base::DictValue d;
    d.Set("id", s.id);
    d.Set("match", s.match);
    d.Set("world", s.isolated_world ? "isolated" : "main");
    d.Set("allFrames", s.all_frames);
    d.Set("sourceLength", static_cast<int>(s.source.size()));
    if (!s.plugin_id.empty()) {
      d.Set("pluginId", s.plugin_id);
    }
    list.Append(std::move(d));
  }
  base::ListValue exposed_list;
  for (const auto& e : exposed_) {
    exposed_list.Append(e.name);
  }
  base::DictValue out;
  out.Set("scripts", std::move(list));
  out.Set("exposedFunctions", std::move(exposed_list));
  return out;
}

base::DictValue DubScriptRegistry::ExposeFunction(
    const std::string& name,
    const std::string& plugin_id) {
  auto it = std::find_if(exposed_.begin(), exposed_.end(),
                         [&](const auto& e) { return e.name == name; });
  if (it == exposed_.end()) {
    exposed_.push_back({name, plugin_id});
  } else {
    it->plugin_id = plugin_id;
  }
  SyncToAllFrames();
  base::DictValue out;
  out.Set("exposed", true);
  out.Set("name", name);
  return out;
}

bool DubScriptRegistry::UnexposeFunction(const std::string& name) {
  auto it = std::find_if(exposed_.begin(), exposed_.end(),
                         [&](const auto& e) { return e.name == name; });
  if (it == exposed_.end()) {
    return false;
  }
  exposed_.erase(it);
  SyncToAllFrames();
  return true;
}

void DubScriptRegistry::SyncToFrame(content::RenderFrameHost* rfh) {
  if (!rfh || !rfh->IsRenderFrameLive()) {
    return;
  }
  mojo::AssociatedRemote<dub::mojom::DubRenderFrame> remote;
  rfh->GetRemoteAssociatedInterfaces()->GetInterface(&remote);
  if (!remote.is_bound()) {
    return;
  }
  std::vector<dub::mojom::InitScriptEntryPtr> payload;
  payload.reserve(scripts_.size());
  for (const auto& s : scripts_) {
    auto entry = dub::mojom::InitScriptEntry::New();
    entry->id = s.id;
    entry->match = s.match;
    entry->source = s.source;
    entry->isolated_world = s.isolated_world;
    entry->all_frames = s.all_frames;
    payload.push_back(std::move(entry));
  }
  remote->SetInitScripts(std::move(payload));

  std::vector<std::string> names;
  names.reserve(exposed_.size());
  for (const auto& e : exposed_) {
    names.push_back(e.name);
  }
  mojo::PendingRemote<dub::mojom::DubExposedHost> host_remote;
  if (!names.empty()) {
    host_receivers_.Add(this, host_remote.InitWithNewPipeAndPassReceiver());
  }
  remote->SetExposedFunctions(names, std::move(host_remote));
}

void DubScriptRegistry::SyncToAllFrames() {
  auto* windows = GlobalBrowserCollection::GetInstance();
  if (!windows) {
    return;
  }
  windows->ForEach([&](BrowserWindowInterface* window) {
    auto* model = window ? window->GetTabStripModel() : nullptr;
    if (!model) {
      return true;
    }
    for (int i = 0; i < model->count(); ++i) {
      if (auto* wc = model->GetWebContentsAt(i)) {
        wc->ForEachRenderFrameHost([&](content::RenderFrameHost* rfh) {
          SyncToFrame(rfh);
        });
      }
    }
    return true;
  });
}

void DubScriptRegistry::Call(const std::string& name,
                             const std::string& args_json,
                             CallCallback callback) {
  base::DictValue data;
  data.Set("name", name);
  if (auto parsed = base::JSONReader::Read(args_json, base::JSON_PARSE_RFC)) {
    data.Set("args", std::move(*parsed));
  } else {
    data.Set("argsJson", args_json);
  }
  DubEventHub::GetInstance().InvokeCallback(
      "page.exposed", std::move(data), 15000,
      base::BindOnce(
          [](CallCallback done, std::optional<base::DictValue> decision) {
            if (!decision) {
              std::move(done).Run(false, "", "Exposed host function timed out");
              return;
            }
            if (const std::string* err = decision->FindString("error");
                err && !err->empty()) {
              std::move(done).Run(false, "", *err);
              return;
            }
            std::string res_json = "null";
            if (const base::Value* val = decision->Find("result")) {
              base::JSONWriter::Write(*val, &res_json);
            }
            std::move(done).Run(true, std::move(res_json), "");
          },
          std::move(callback)));
}

}  // namespace dub
