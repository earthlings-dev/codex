# Patches

This directory contains patches for upstream dependencies used via `[patch.crates-io]` in `Cargo.toml`.

## tree-sitter-c23.patch

**Issue:** tree-sitter 0.25.10 has a type error at `src/parser.c:2217` where it returns `false` instead of `NULL`. C11 silently converts this, but C23 treats it as a hard error.

**Fix:** One-line change: `return false;` → `return NULL;`

**Status:** Pending upstream PR to tree-sitter/tree-sitter

**Cargo.toml:** Currently using path-based patch for local development. Will switch to git fork once PR is submitted.
