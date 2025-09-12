#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/event.h>
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

static void pid_set_remove(struct pid_set *set, pid_t pid) {
    for (size_t i = 0; i < set->count; ++i) {
        if (set->data[i] == pid) {
            set->data[i] = set->data[set->count - 1];
            --set->count;
            return;
        }
    }
}

static void child_buffer_free(struct child_buffer *buffer) {
    free(buffer->data);
    buffer->data = NULL;
    buffer->capacity = 0;
}

static int list_children(pid_t pid, struct child_buffer *buffer, pid_t **children, size_t *count) {
    if (buffer->capacity == 0) {
        buffer->capacity = 16;
        buffer->data = malloc(buffer->capacity * sizeof(pid_t));
        if (!buffer->data) {
            return -1;
        }
    }

    for (;;) {
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

static int watch_pid(int kq, pid_t pid) {
    struct kevent kev;
    EV_SET(&kev, pid, EVFILT_PROC, EV_ADD | EV_CLEAR, NOTE_FORK | NOTE_EXEC | NOTE_EXIT, 0, NULL);
    if (kevent(kq, &kev, 1, NULL, 0, NULL) < 0) {
        if (errno == ESRCH) {
            return 1;
        }
        perror("kevent");
        exit(1);
    }
    return 0;
}

static void add_pid_watch(int kq,
                          pid_t pid,
                          struct pid_set *seen,
                          struct pid_set *active,
                          struct child_buffer *buffer);

static void ensure_children(int kq,
                            pid_t parent,
                            struct pid_set *seen,
                            struct pid_set *active,
                            struct child_buffer *buffer) {
    pid_t *children = NULL;
    size_t count = 0;
    if (list_children(parent, buffer, &children, &count) != 0) {
        perror("proc_listchildpids");
        return;
    }

    for (size_t i = 0; i < count; ++i) {
        pid_t child_pid = children[i];
        if (child_pid <= 0) {
            continue;
        }

        bool already_seen = pid_set_contains(seen, child_pid);
        bool is_active = pid_set_contains(active, child_pid);

        if (!already_seen) {
            add_pid_watch(kq, child_pid, seen, active, buffer);
        } else if (!is_active) {
            pid_set_add(active, child_pid);
            if (watch_pid(kq, child_pid) == 1) {
                pid_set_remove(active, child_pid);
                continue;
            }
            ensure_children(kq, child_pid, seen, active, buffer);
        }
    }
}

static void add_pid_watch(int kq,
                          pid_t pid,
                          struct pid_set *seen,
                          struct pid_set *active,
                          struct child_buffer *buffer) {
    if (pid <= 0) {
        return;
    }

    bool already_seen = pid_set_contains(seen, pid);
    if (!already_seen) {
        pid_set_add(seen, pid);
    }

    if (!pid_set_contains(active, pid)) {
        pid_set_add(active, pid);
        if (watch_pid(kq, pid) == 1) {
            pid_set_remove(active, pid);
            return;
        }
    }

    if (!already_seen) {
        ensure_children(kq, pid, seen, active, buffer);
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

    int kq = kqueue();
    if (kq < 0) {
        perror("kqueue");
        return 1;
    }

    struct pid_set seen = {0};
    struct pid_set active = {0};
    struct child_buffer child_buf = {0};

    add_pid_watch(kq, child, &seen, &active, &child_buf);

    bool child_exited = !pid_set_contains(&active, child);
    int child_status = 0;

    while (!child_exited || active.count > 0) {
        if (!child_exited && active.count == 0) {
            pid_t res = waitpid(child, &child_status, 0);
            if (res == child) {
                child_exited = true;
                break;
            }
            if (res < 0) {
                if (errno == EINTR) {
                    continue;
                }
                if (errno == ECHILD) {
                    child_exited = true;
                    break;
                }
                perror("waitpid");
                break;
            }
        }

        struct kevent events[32];
        int nev = kevent(kq, NULL, 0, events, 32, NULL);
        if (nev < 0) {
            if (errno == EINTR) {
                continue;
            }
            perror("kevent");
            break;
        }

        for (int i = 0; i < nev; ++i) {
            struct kevent *ev = &events[i];
            pid_t pid = (pid_t)ev->ident;

            if (ev->flags & EV_ERROR) {
                if (ev->data == ESRCH) {
                    pid_set_remove(&active, pid);
                    if (pid == child) {
                        child_exited = true;
                    }
                    continue;
                }
                errno = (int)ev->data;
                perror("kevent event");
                continue;
            }

            if (ev->fflags & NOTE_FORK) {
                ensure_children(kq, pid, &seen, &active, &child_buf);
            }

            if (ev->fflags & NOTE_EXIT) {
                pid_set_remove(&active, pid);
                if (pid == child) {
                    child_exited = true;
                }
            }
        }

        if (!child_exited) {
            pid_t res = waitpid(child, &child_status, WNOHANG);
            if (res == child) {
                child_exited = true;
            }
        }
    }

    if (!child_exited) {
        while (waitpid(child, &child_status, 0) < 0) {
            if (errno != EINTR) {
                perror("waitpid");
                break;
            }
        }
    }

    for (size_t i = 0; i < seen.count; ++i) {
        printf("%d\n", (int)seen.data[i]);
    }

    pid_set_free(&seen);
    pid_set_free(&active);
    child_buffer_free(&child_buf);
    close(kq);

    return 0;
}
