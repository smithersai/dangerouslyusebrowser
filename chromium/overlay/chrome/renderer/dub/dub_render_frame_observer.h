// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_RENDERER_DUB_DUB_RENDER_FRAME_OBSERVER_H_
#define CHROME_RENDERER_DUB_DUB_RENDER_FRAME_OBSERVER_H_

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "chrome/common/dub_frame.mojom.h"
#include "content/public/renderer/render_frame_observer.h"
#include "mojo/public/cpp/bindings/associated_receiver_set.h"
#include "mojo/public/cpp/bindings/pending_associated_receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-persistent-handle.h"
#include "v8/include/v8-promise.h"

namespace dub {

class DubRenderFrameObserver : public content::RenderFrameObserver,
                               public dub::mojom::DubRenderFrame {
 public:
  explicit DubRenderFrameObserver(content::RenderFrame* render_frame);
  ~DubRenderFrameObserver() override;

  DubRenderFrameObserver(const DubRenderFrameObserver&) = delete;
  DubRenderFrameObserver& operator=(const DubRenderFrameObserver&) = delete;

  void ResolvePendingEval(uint64_t eval_id,
                          bool ok,
                          std::string result_json,
                          std::string error_code,
                          std::string error_message);

  void HandleExposedCallFromV8(const std::string& name,
                               const std::string& args_json,
                               v8::Isolate* isolate,
                               v8::Local<v8::Context> context,
                               v8::Local<v8::Promise::Resolver> resolver);

 private:
  void OnDubRenderFrameRequest(
      mojo::PendingAssociatedReceiver<dub::mojom::DubRenderFrame> receiver);

  // content::RenderFrameObserver:
  void DidClearWindowObject() override;
  void DidStartNavigation(
      const GURL& url,
      std::optional<blink::WebNavigationType> navigation_type) override;
  void OnDestruct() override;

  // dub::mojom::DubRenderFrame:
  void Evaluate(const std::string& expression,
                EvaluateCallback callback) override;
  void EvaluateEx(const std::string& expression,
                  bool isolated_world,
                  EvaluateExCallback callback) override;
  void ListPageTools(ListPageToolsCallback callback) override;
  void ExecutePageTool(const base::UnguessableToken& invocation_id,
                       const std::string& name,
                       const std::string& input_arguments,
                       ExecutePageToolCallback callback) override;
  void CancelPageTool(const base::UnguessableToken& invocation_id) override;
  void ResolveTarget(const std::string& target,
                     bool is_selector,
                     ResolveTargetCallback callback) override;
  void Snapshot(uint32_t max_nodes,
                bool include_hidden,
                SnapshotCallback callback) override;
  void ClockControl(const std::string& op,
                    int64_t epoch_ms,
                    int64_t delta_ms,
                    uint32_t frames,
                    ClockControlCallback callback) override;
  void SetInitScripts(
      std::vector<dub::mojom::InitScriptEntryPtr> scripts) override;
  void SetExposedFunctions(
      const std::vector<std::string>& names,
      mojo::PendingRemote<dub::mojom::DubExposedHost> host) override;
  void WaitFor(const std::string& selector,
               const std::string& text,
               const std::string& expression,
               const std::string& state,
               uint32_t timeout_ms,
               WaitForCallback callback) override;

  void FailPendingEvals(const std::string& code, const std::string& message);
  void InstallExposedBindingsInCurrentContext();
  void RunInitScriptsForCurrentDocument();

  mojo::AssociatedReceiverSet<dub::mojom::DubRenderFrame> receivers_;
  uint64_t next_eval_id_ = 1;
  std::map<uint64_t, EvaluateCallback> pending_evals_;
  std::vector<dub::mojom::InitScriptEntryPtr> init_scripts_;
  std::vector<std::string> exposed_names_;
  mojo::Remote<dub::mojom::DubExposedHost> exposed_host_;
  base::WeakPtrFactory<DubRenderFrameObserver> weak_factory_{this};
};

}  // namespace dub

#endif  // CHROME_RENDERER_DUB_DUB_RENDER_FRAME_OBSERVER_H_
