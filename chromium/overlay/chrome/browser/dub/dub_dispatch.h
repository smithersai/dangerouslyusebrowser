// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_DISPATCH_H_
#define CHROME_BROWSER_DUB_DUB_DISPATCH_H_
#include "base/functional/callback.h"
#include "base/values.h"
namespace dub {
using Reply = base::OnceCallback<void(base::DictValue)>;
base::DictValue Result(base::Value value);
base::DictValue Error(const std::string& code, const std::string& message);
void Dispatch(base::DictValue request, Reply reply);
}
#endif
