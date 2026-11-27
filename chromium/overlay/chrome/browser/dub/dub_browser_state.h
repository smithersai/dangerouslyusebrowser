// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_BROWSER_STATE_H_
#define CHROME_BROWSER_DUB_DUB_BROWSER_STATE_H_

#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "chrome/common/dub_frame.mojom.h"
#include "components/download/public/common/download_item.h"
#include "content/public/browser/download_manager.h"
#include "content/public/browser/javascript_dialog_manager.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "mojo/public/cpp/bindings/receiver_set.h"

class Profile;

namespace content {
class RenderFrameHost;
class WebContents;
}  // namespace content

namespace dub {

// Returns a Dub JavaScriptDialogManager when policy != "default", or nullptr to
// fall through to Chromium's normal TabModalDialogManager.
content::JavaScriptDialogManager* GetDialogManagerIfEnabled(
    content::WebContents* contents);

// Ensures DubTabObserver is attached to a WebContents and returns it.
class DubTabObserver : public content::WebContentsObserver,
                       public content::WebContentsUserData<DubTabObserver> {
 public:
  ~DubTabObserver() override;

  static DubTabObserver* EnsureForWebContents(content::WebContents* contents);

  base::DictValue ReadConsole(uint64_t since,
                              const std::string& level_filter,
                              bool clear);

  // Registers a one-shot waiter for navigation readiness:
  // "commit" | "domcontentloaded" | "load" | "networkidle".
  void AddNavigationWaiter(const std::string& wait_until,
                           base::OnceClosure callback);

 private:
  friend class content::WebContentsUserData<DubTabObserver>;
  explicit DubTabObserver(content::WebContents* contents);

  struct ConsoleEntry {
    uint64_t seq = 0;
    int64_t timestamp_ms = 0;
    std::string level;
    std::string message;
    std::string source;
    int line = 0;
    std::string frame_id;
  };

  struct NavWaiter {
    std::string wait_until;
    base::OnceClosure callback;
  };

  // content::WebContentsObserver:
  void RenderFrameCreated(content::RenderFrameHost* rfh) override;
  void ReadyToCommitNavigation(content::NavigationHandle* handle) override;
  void DidFinishNavigation(content::NavigationHandle* handle) override;
  void DOMContentLoaded(content::RenderFrameHost* rfh) override;
  void DidFinishLoad(content::RenderFrameHost* rfh,
                     const GURL& validated_url) override;
  void DidStopLoading() override;
  void OnDidAddMessageToConsole(
      content::RenderFrameHost* source_frame,
      blink::mojom::ConsoleMessageLevel log_level,
      const std::u16string& message,
      int32_t line_no,
      const std::u16string& source_id,
      const std::optional<std::u16string>& untrusted_stack_trace) override;
  void WebContentsDestroyed() override;

  void FireWaiters(const std::string& stage);
  void SyncFrameScripts(content::RenderFrameHost* rfh);

  uint64_t next_console_seq_ = 1;
  std::deque<ConsoleEntry> console_entries_;
  std::vector<NavWaiter> nav_waiters_;

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

class DubDialogManager : public content::JavaScriptDialogManager {
 public:
  static DubDialogManager& GetInstance();

  bool IsEnabled() const { return mode_ != "default"; }

  base::DictValue SetPolicy(const base::DictValue& params, std::string* error);
  base::DictValue GetPolicy() const;
  base::DictValue ListDialogs() const;
  bool RespondDialog(const std::string& id,
                     bool accept,
                     const std::string& prompt_text);

  // content::JavaScriptDialogManager:
  void RunJavaScriptDialog(content::WebContents* web_contents,
                           content::RenderFrameHost* render_frame_host,
                           content::JavaScriptDialogType dialog_type,
                           const std::u16string& message_text,
                           const std::u16string& default_prompt_text,
                           DialogClosedCallback callback,
                           bool* did_suppress_message) override;
  void RunBeforeUnloadDialog(content::WebContents* web_contents,
                             content::RenderFrameHost* render_frame_host,
                             bool is_reload,
                             DialogClosedCallback callback) override;
  void CancelDialogs(content::WebContents* web_contents,
                     bool reset_state) override;

 private:
  friend class base::NoDestructor<DubDialogManager>;
  struct PendingDialog {
    std::string id;
    std::string callback_id;
    int tab_id = 0;
    std::string type;
    std::string message;
    std::string default_prompt;
    raw_ptr<content::WebContents> web_contents = nullptr;
    DialogClosedCallback callback;
  };

  DubDialogManager();
  ~DubDialogManager() override;

  void FinishDialog(const std::string& id,
                    bool accept,
                    const std::string& prompt_text);

  std::string mode_ = "default";
  std::string default_prompt_text_;
  int callback_timeout_ms_ = 15000;
  uint64_t next_dialog_id_ = 1;
  std::vector<std::unique_ptr<PendingDialog>> pending_;
  base::WeakPtrFactory<DubDialogManager> weak_factory_{this};
};

class DubDownloadTracker : public content::DownloadManager::Observer,
                           public download::DownloadItem::Observer {
 public:
  static DubDownloadTracker& GetInstance();

  void EnsureAttached(Profile* profile);
  base::DictValue Configure(Profile* profile,
                            const base::DictValue& params,
                            std::string* error);
  base::DictValue ListDownloads() const;
  void WaitForDownload(const std::string& id_filter,
                       base::OnceCallback<void(base::DictValue)> callback);

  // content::DownloadManager::Observer:
  void OnDownloadCreated(content::DownloadManager* manager,
                         download::DownloadItem* item) override;
  void ManagerGoingDown(content::DownloadManager* manager) override;

  // download::DownloadItem::Observer:
  void OnDownloadUpdated(download::DownloadItem* item) override;
  void OnDownloadDestroyed(download::DownloadItem* item) override;

 private:
  friend class base::NoDestructor<DubDownloadTracker>;
  struct DownloadRecord {
    std::string id;
    std::string url;
    std::string filename;
    std::string target_path;
    std::string mime_type;
    std::string state;
    int64_t received_bytes = 0;
    int64_t total_bytes = 0;
  };

  struct Waiter {
    std::string id_filter;
    base::OnceCallback<void(base::DictValue)> callback;
  };

  DubDownloadTracker();
  ~DubDownloadTracker() override;

  base::DictValue SerializeRecord(const DownloadRecord& r) const;
  void UpdateFromItem(download::DownloadItem* item);

  raw_ptr<content::DownloadManager> manager_ = nullptr;
  std::map<uint32_t, DownloadRecord> records_;
  std::vector<Waiter> waiters_;
};

class DubScriptRegistry : public dub::mojom::DubExposedHost {
 public:
  static DubScriptRegistry& GetInstance();

  base::DictValue AddScript(const base::DictValue& params, std::string* error);
  bool RemoveScript(const std::string& id);
  int RemoveByPlugin(const std::string& plugin_id);
  base::DictValue ListScripts() const;

  base::DictValue ExposeFunction(const std::string& name,
                                 const std::string& plugin_id);
  bool UnexposeFunction(const std::string& name);

  void SyncToFrame(content::RenderFrameHost* rfh);
  void SyncToAllFrames();

  // dub::mojom::DubExposedHost:
  void Call(const std::string& name,
            const std::string& args_json,
            CallCallback callback) override;

 private:
  friend class base::NoDestructor<DubScriptRegistry>;
  struct ScriptRecord {
    std::string id;
    std::string match;
    std::string source;
    bool isolated_world = false;
    bool all_frames = true;
    std::string plugin_id;
  };

  struct ExposedRecord {
    std::string name;
    std::string plugin_id;
  };

  DubScriptRegistry();
  ~DubScriptRegistry() override;

  uint64_t next_script_id_ = 1;
  std::vector<ScriptRecord> scripts_;
  std::vector<ExposedRecord> exposed_;
  mojo::ReceiverSet<dub::mojom::DubExposedHost> host_receivers_;
};

}  // namespace dub

#endif  // CHROME_BROWSER_DUB_DUB_BROWSER_STATE_H_
