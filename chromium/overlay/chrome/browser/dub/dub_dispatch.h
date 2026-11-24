// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_DISPATCH_H_
#define CHROME_BROWSER_DUB_DUB_DISPATCH_H_

#include <cstdint>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"

class Profile;

namespace dub {

using Reply = base::OnceCallback<void(base::DictValue)>;
using CancelSetter = base::OnceCallback<void(base::OnceClosure)>;

struct SessionContext {
  base::WeakPtr<Profile> profile;
  std::string profile_path;
  std::string instance_id;
  base::RepeatingCallback<uint32_t()> next_task_id;
};

base::DictValue Result(base::Value value);
base::DictValue Error(const std::string& code, const std::string& message);

void Dispatch(const SessionContext& session,
              base::DictValue request,
              Reply reply,
              CancelSetter set_cancel);

}  // namespace dub

#endif  // CHROME_BROWSER_DUB_DUB_DISPATCH_H_
