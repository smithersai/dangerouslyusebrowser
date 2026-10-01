#ifndef DUB_H
#define DUB_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
/* One length-prefixed JSON request per connection. Caller owns output/error. */
int dub_call(const char* socket_path, const char* request, size_t request_size,
             unsigned timeout_ms, char** output, size_t* output_size, char** error);
void dub_free(void* memory);
#ifdef __cplusplus
}
#endif
#endif
