// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_upload.h"

#include <map>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/no_destructor.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/file_select_listener.h"
#include "content/public/browser/render_frame_host.h"
#include "third_party/blink/public/mojom/choosers/file_chooser.mojom.h"

namespace dub {
namespace {

std::map<content::GlobalRenderFrameHostId, std::vector<base::FilePath>>&
ArmedUploads() {
  static base::NoDestructor<
      std::map<content::GlobalRenderFrameHostId, std::vector<base::FilePath>>>
      map;
  return *map;
}

}  // namespace

void ArmFileUpload(content::GlobalRenderFrameHostId frame_id,
                   std::vector<base::FilePath> files) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  ArmedUploads()[frame_id] = std::move(files);
}

void ClearFileUpload(content::GlobalRenderFrameHostId frame_id) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  ArmedUploads().erase(frame_id);
}

bool TryHandleFileChooser(content::RenderFrameHost* render_frame_host,
                          scoped_refptr<content::FileSelectListener> listener,
                          const blink::mojom::FileChooserParams& params) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!render_frame_host) {
    return false;
  }
  auto& uploads = ArmedUploads();
  auto it = uploads.find(render_frame_host->GetGlobalId());
  if (it == uploads.end()) {
    return false;
  }
  auto paths = std::move(it->second);
  uploads.erase(it);

  std::vector<blink::mojom::FileChooserFileInfoPtr> selected;
  selected.reserve(paths.size());
  for (const auto& path : paths) {
    selected.push_back(blink::mojom::FileChooserFileInfo::NewNativeFile(
        blink::mojom::NativeFileInfo::New(path, std::u16string(),
                                          std::vector<std::u16string>())));
  }
  listener->FileSelected(std::move(selected), base::FilePath(), params.mode);
  return true;
}

}  // namespace dub
