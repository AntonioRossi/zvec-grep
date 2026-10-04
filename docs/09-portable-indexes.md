# Move and reuse an index

[Documentation](./README.md) · [CLI](./02-cli.md) · [MCP](./03-mcp.md)

A change in workspace location should not require another embedding run for
unchanged documents. Use a portable index to keep stored vectors when you move
an indexed workspace. These instructions apply to the Node.js implementation.

## Choose the operation

| Need                                                    | Operation                                          |
| ------------------------------------------------------- | -------------------------------------------------- |
| Move a complete workspace on a compatible host          | Relocation of the files and `.zvec-grep/` together |
| Convert an old absolute-path index (manifest version 1) | Migration to manifest version 2                    |
| Transfer across hosts or native database environments   | Logical export and import                          |

Keep a restorable copy before you change a workspace. Stop indexing and close
services that use it before you copy native index files. Do not copy a live
database. A successful search alone does not prove that document vectors were
reused; use the verification checks below.

## Destination and model requirements

- The workspace must be self-contained. All configured roots must resolve
  inside it. Copy the source documents with the same relative paths.
- A migration or import destination must not already contain a workspace index.
  An export artifact path must be new. Keep artifacts outside indexed roots.
  Do not remove an existing index to make a failed command succeed.
- Migration and export read private copies of native storage. Allow temporary
  disk space for the source collections as well as space for the destination.
  The copies are removed before publication. Native reader metadata changes
  cannot affect the original index.
- Use a version that supports the artifact format and portable manifest.
  Logical import creates native storage on the receiving host. It does not
  require compatible native database files from the sending host.
- Credentials and host bindings do not transfer. Configure credentials on the
  receiving host. Configure the same embedding model for vector queries and
  incremental indexing; install its model files there if it is a local model.
  Device selection is local to the host.
- Remote query or document embeddings need the normal authorization on the
  receiving host. Transfer does not grant that authorization.
- An artifact contains indexed text, paths and vectors. Protect it as you
  protect the source documents. Removal of credentials is not encryption.

## Relocation

Move the complete workspace and its `.zvec-grep/` directory together. Preserve
the paths inside the workspace. The portable manifest stores workspace-relative
paths; the receiving process creates its own host binding. It retains the index
identity. Native file copies still require a compatible storage environment.
Use logical transfer when that compatibility is not established.

Converting this complete directory into a Git submodule does not itself change
its internal paths. Git does not transfer an ignored `.zvec-grep/` directory.
Transfer that index separately. These commands do not split a larger index or
extract one indexed subtree into an independent index.

## Migration

This example converts a legacy index into a separate workspace that already
contains the corresponding documents:

```bash
zg --migrate-index /old/project/.zvec-grep /new/project
```

The source index is not modified. The destination is built in a staging
directory, verified, and then published. The workspace index identity and
vectors are preserved; path-derived file and fragment identifiers change to
the portable form. Review the returned missing-file list. Do not claim a
complete workspace when source documents are absent.

## Logical export and import

On the sending host:

```bash
zg --export-index /source/project/.zvec-grep /transfer/project-index
```

The source is read under a lock that excludes writers. The artifact contains
versioned metadata, file records and fragments with vectors. No model runs
during export. Copy the complete artifact and the source documents to the
receiving host. This copy is a separate operation, outside the CLI and MCP.
Verify file inventory and checksums after the copy, before import.

On the receiving host, with the documents at their original relative paths:

```bash
zg --import-index /received/project-index /destination/project
```

Import validates the artifact and builds native storage in a staging directory.
It verifies counts, identities, ownership, inventories, groups and vectors
before publication. It does not compute embeddings. Keep the original artifact
and source index until verification is complete. A lock conflict or occupied
destination is an error; resolve the owner of that resource before retrying.

Migration, export and import are also available through the full MCP toolset:
`zvec_grep_index_migrate`, `zvec_grep_index_export` and `zvec_grep_index_import`.
Each requires `confirm: true` after an explicit user request. Existing MCP
search and indexing tools can read and update the result. A tool path is a path visible to the server,
not necessarily to the agent's computer. An agent must have an explicit user
request before it creates or changes a persistent index.

## Verify reuse and updates

1. Record the source index identity from `.zvec-grep/manifest.json` and the
   source revision. After transfer, compare the destination manifest identity.
2. Check command exits and conversion results, including missing files and
   verification fields. For a copied artifact, compare the full inventory and
   checksums. A transport success message is insufficient.
3. Search for expected content and verify its file path under the destination.
   Query embeddings can still occur. They are separate from document embeddings.
4. The migrated or imported index starts unverified. Its first indexing run
   reconciles content by hash. Unchanged documents reuse vectors; changed
   documents can require new embeddings. Record document-embedding calls when
   testing a zero-document-embedding claim.
5. In a disposable copy, change one document and remove another. Run indexing
   explicitly. Check the changed content, removal of deleted files from stored
   entries, and preservation of unrelated documents. Retain the output and exits.

See `zg --help migrate`, `zg --help export` and `zg --help import` for the
installed command contract. The [design contract](./design/portable-workspace-index.md)
states the identity rules and the limits of the recorded evidence.
