// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_RENDERER_DUB_DUB_RENDER_FRAME_OBSERVER_H_
#define CHROME_RENDERER_DUB_DUB_RENDER_FRAME_OBSERVER_H_

#include <cstdint>
#include <map>
#include <string>

#include "base/memory/weak_ptr.h"
#include "base/unguessable_token.h"
#include "chrome/common/dub_frame.mojom.h"
#include "content/public/renderer/render_frame_observer.h"
#include "mojo/public/cpp/bindings/associated_receiver_set.h"
#include "mojo/public/cpp/bindings/pending_associated_receiver.h"

namespace dub {

class DubRenderFrameObserver : public content::RenderFrameObserver,
                               public dub::mojom::DubRenderFrame {
 public:
  explicit DubRenderFrameObserver(content::RenderFrame* render_frame);
  DubRenderFrameObserver(const DubRenderFrameObserver&) = delete;
  DubRenderFrameObserver& operator=(const DubRenderFrameObserver&) = delete;
  ~DubRenderFrameObserver() override;

  // dub::mojom::DubRenderFrame:
  void Evaluate(const std::string& expression,
                EvaluateCallback callback) override;
  void ListPageTools(ListPageToolsCallback callback) override;
  void ExecutePageTool(const base::UnguessableToken& invocation_id,
                       const std::string& name,
                       const std::string& input_arguments,
                       ExecutePageToolCallback callback) override;
  void CancelPageTool(const base::UnguessableToken& invocation_id) override;
  void ResolveTarget(const std::string& target,
                     bool is_selector,
                     ResolveTargetCallback callback) override;
  void ClockControl(const std::string& op,
                    int64_t epoch_ms,
                    int64_t delta_ms,
                    uint32_t frames,
                    ClockControlCallback callback) override;

  void ResolvePendingEval(uint64_t eval_id,
                          bool ok,
                          std::string result_json,
                          std::string error_code,
                          std::string error_message);

 private:
  void OnDubRenderFrameRequest(
      mojo::PendingAssociatedReceiver<dub::mojom::DubRenderFrame> receiver);

  // content::RenderFrameObserver:
  void DidStartNavigation(
      const GURL& url,
      std::optional<blink::WebNavigationType> navigation_type) override;
  void OnDestruct() override;

  void FailPendingEvals(const std::string& code, const std::string& message);

  uint64_t next_eval_id_ = 1;
  std::map<uint64_t, EvaluateCallback> pending_evals_;
  mojo::AssociatedReceiverSet<dub::mojom::DubRenderFrame> receivers_;
  base::WeakPtrFactory<DubRenderFrameObserver> weak_factory_{this};
};

}  // namespace dub

#endif  // CHROME_RENDERER_DUB_DUB_RENDER_FRAME_OBSERVER_H_
