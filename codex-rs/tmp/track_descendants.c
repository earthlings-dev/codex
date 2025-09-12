#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

struct pid_set {
    pid_t *data;
    size_t count;
    size_t capacity;
};

struct child_buffer {
    pid_t *data;
    size_t capacity;
};

static void pid_set_free(struct pid_set *set) {
    free(set->data);
    set->data = NULL;
    set->count = 0;
    set->capacity = 0;
}

static bool pid_set_contains(const struct pid_set *set, pid_t pid) {
    for (size_t i = 0; i < set->count; ++i) {
        if (set->data[i] == pid) {
            return true;
        }
    }
    return false;
}

static void pid_set_add(struct pid_set *set, pid_t pid) {
    if (pid <= 0 || pid_set_contains(set, pid)) {
        return;
    }
    if (set->count == set->capacity) {
        size_t new_capacity = set->capacity ? set->capacity * 2 : 16;
        pid_t *new_data = realloc(set->data, new_capacity * sizeof(pid_t));
        if (!new_data) {
            perror("realloc");
            exit(1);
        }
        set->data = new_data;
        set->capacity = new_capacity;
    }
    set->data[set->count++] = pid;
}

static void pid_set_clear(struct pid_set *set) {
    set->count = 0;
}

static void pid_set_swap(struct pid_set *a, struct pid_set *b) {
    struct pid_set tmp = *a;
    *a = *b;
    *b = tmp;
}

static void child_buffer_free(struct child_buffer *buffer) {
    free(buffer->data);
    buffer->data = NULL;
    buffer->capacity = 0;
}

static bool pid_is_alive(pid_t pid) {
    if (pid <= 0) {
        return false;
    }
    if (kill(pid, 0) == 0) {
        return true;
    }
    return errno == EPERM;
}

static int list_children(pid_t pid, struct child_buffer *buffer, pid_t **children, size_t *count) {
    if (buffer->capacity == 0) {
        buffer->capacity = 16;
        buffer->data = malloc(buffer->capacity * sizeof(pid_t));
        if (!buffer->data) {
            return -1;
        }
    }

    while (1) {
        int result = proc_listchildpids(pid, buffer->data, (int)(buffer->capacity * sizeof(pid_t)));
        if (result < 0) {
            if (errno == ESRCH) {
                *children = NULL;
                *count = 0;
                return 0;
            }
            return -1;
        }
        size_t returned = (size_t)result;
        if (returned < buffer->capacity) {
            *children = buffer->data;
            *count = returned;
            return 0;
        }
        size_t new_capacity = buffer->capacity * 2;
        pid_t *new_data = realloc(buffer->data, new_capacity * sizeof(pid_t));
        if (!new_data) {
            return -1;
        }
        buffer->data = new_data;
        buffer->capacity = new_capacity;
    }
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <command> [args...]\n", argv[0]);
        return 1;
    }

    pid_t child = fork();
    if (child < 0) {
        perror("fork");
        return 1;
    }

    if (child == 0) {
        execvp(argv[1], &argv[1]);
        perror("execvp");
        _exit(127);
    }

    struct pid_set seen = {0};
    struct pid_set active = {0};
    struct pid_set next_active = {0};
    struct pid_set to_poll = {0};
    struct pid_set next_to_poll = {0};
    struct child_buffer child_buf = {0};

    pid_set_add(&seen, child);
    pid_set_add(&active, child);
    pid_set_add(&to_poll, child);

    int child_status = 0;
    bool child_exited = false;
    int warmup_iterations = 200;

    while (!child_exited || active.count > 0) {
        if (!child_exited) {
            pid_t res = waitpid(child, &child_status, WNOHANG);
            if (res == child) {
                child_exited = true;
            }
        }

        pid_set_clear(&next_active);
        pid_set_clear(&next_to_poll);

        for (size_t i = 0; i < to_poll.count; ++i) {
            pid_t current = to_poll.data[i];
            if (!pid_is_alive(current)) {
                continue;
            }

            pid_set_add(&next_active, current);
            pid_set_add(&next_to_poll, current);

            pid_t *children = NULL;
            size_t child_count = 0;
            if (list_children(current, &child_buf, &children, &child_count) != 0) {
                perror("proc_listchildpids");
                continue;
            }

            for (size_t j = 0; j < child_count; ++j) {
                pid_t child_pid = children[j];
                if (child_pid <= 0) {
                    continue;
                }
                if (!pid_set_contains(&seen, child_pid)) {
                    pid_set_add(&seen, child_pid);
                }
                if (pid_is_alive(child_pid)) {
                    pid_set_add(&next_active, child_pid);
                    pid_set_add(&next_to_poll, child_pid);
                }
            }
        }

        pid_set_swap(&active, &next_active);
        pid_set_swap(&to_poll, &next_to_poll);
        pid_set_clear(&next_active);
        pid_set_clear(&next_to_poll);

        if (child_exited && active.count == 0) {
            break;
        }

        unsigned int delay = warmup_iterations > 0 ? 100 : 5000;
        if (warmup_iterations > 0) {
            --warmup_iterations;
        }
        usleep(delay);
    }

    if (!child_exited) {
        waitpid(child, &child_status, 0);
    }

    for (size_t i = 0; i < seen.count; ++i) {
        printf("%d\n", (int)seen.data[i]);
    }

    pid_set_free(&seen);
    pid_set_free(&active);
    pid_set_free(&next_active);
    pid_set_free(&to_poll);
    pid_set_free(&next_to_poll);
    child_buffer_free(&child_buf);

    return 0;
}
