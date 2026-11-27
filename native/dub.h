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

/* Persistent framed JSON event/callback stream over the same AF_UNIX socket. */
typedef struct dub_stream dub_stream_t;

/* Connects, sends the initial subscribe request, reads the initial ack into
   ack/ack_size, and returns a live stream handle. Caller owns ack/error. */
int dub_stream_open(const char* socket_path, const char* request, size_t request_size,
                    unsigned timeout_ms, dub_stream_t** out_stream,
                    char** ack, size_t* ack_size, char** error);

/* Blocks until the next framed message arrives (returns 0), the stream is
   closed cleanly (returns 1), or an error occurs (returns -1 with *error). */
int dub_stream_read(dub_stream_t* stream, char** output, size_t* output_size, char** error);

/* Signals any blocked dub_stream_read to wake up immediately. Thread-safe. */
void dub_stream_cancel(dub_stream_t* stream);

/* Closes and frees the stream after dub_stream_read has exited. */
void dub_stream_close(dub_stream_t* stream);
#ifdef __cplusplus
}
#endif
#endif
