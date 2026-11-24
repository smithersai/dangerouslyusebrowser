// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_UPLOAD_H_
#define CHROME_BROWSER_DUB_DUB_UPLOAD_H_

#include <vector>

#include "base/files/file_path.h"
#include "base/memory/scoped_refptr.h"
#include "content/public/browser/global_routing_id.h"
#include "third_party/blink/public/mojom/choosers/file_chooser.mojom-forward.h"

namespace content {
class FileSelectListener;
class RenderFrameHost;
}  // namespace content

namespace dub {

// Arms a one-shot file selection override for the given frame so a native
// actor click on <input type="file"> supplies ONLY these explicit file paths
// without opening an OS dialog.
void ArmFileUpload(content::GlobalRenderFrameHostId frame_id,
                   std::vector<base::FilePath> files);

void ClearFileUpload(content::GlobalRenderFrameHostId frame_id);

// Called from FileSelectHelper::RunFileChooser. Returns true if Dub handled
// the chooser request for `render_frame_host`.
bool TryHandleFileChooser(content::RenderFrameHost* render_frame_host,
                          scoped_refptr<content::FileSelectListener> listener,
                          const blink::mojom::FileChooserParams& params);

}  // namespace dub

#endif  // CHROME_BROWSER_DUB_DUB_UPLOAD_H_
