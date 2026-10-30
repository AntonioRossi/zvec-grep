# Node fork guide

These instructions describe the Node fork. Use the
[move guide](./09-portable-indexes.md) for relocation, migration, logical
transfer and recovery. The [portable-index contract](./design/portable-workspace-index.md)
gives the identity rules, design limits and required behavior.

## Command reference

Use `zg --help` and its command topics for the installed command interface.
Use `zg --help index` before an explicit indexing operation, `zg --help server`
for server configuration and authentication, and `zg --help install` for agent
setup. Full MCP mode includes the three
[portable-index tools](./09-portable-indexes.md#mcp-requests).

The indexing option is `--embedding-concurrency`. Its environment variable is
`ZVEC_GREP_EMBEDDING_CONCURRENCY`. Search output defaults to `--preview short`
in terminals, pipes and redirected files. Use `--preview detail` for full
content with detailed metadata and file groups.

## Implementation scope

The `pi` install and uninstall target is available only in Rust. Node rejects
it. Rust uses `PI_CODING_AGENT_DIR` for the Pi MCP configuration and active
context file. See the [Rust instructions](../rust/README.md) for that interface.

The Rust installer is separate. Its OpenCode installer selects a configuration
file but does not perform the Node fork's inspection across merged files.
The Node regressions do not verify Rust installer behavior. Rust parity needs
separate evidence.

## OpenCode installation

OpenCode merges `config.json`, `opencode.json`, `opencode.jsonc`, then an explicit
`OPENCODE_CONFIG`. Later files replace conflicting keys. Other fields from
earlier files remain effective. Before a write, the Node installer inspects
all three default global files and the explicit file, when selected.

An unmanaged `zvec_grep` entry in any inspected file stops installation unless
you use `--force`. The error identifies the file. Without force, all
configuration files and `AGENTS.md` stay unchanged. Each inspected file must
parse and have a valid `mcp` container. Force does not bypass those checks.

Force writes only the selected configuration file and its adjacent `AGENTS.md`.
Other files stay unchanged. Fields in sibling entries, such as an authorization
header, can remain effective in the merged configuration. Inspect those files
before you use force.

An entry is recognized as managed when its structure matches the configured
server URL or a supported `zg` command. An entry from another configuration
can match that structure. Unrecognized entries require force; force replaces
them only in the selected file.

Without `OPENCODE_CONFIG`, uninstall removes recognized entries from the
default `opencode.json` and `opencode.jsonc`. With the variable, it checks only
the selected file. It does not clean legacy `config.json` or other merged
locations. Uninstall also removes the managed block in the `AGENTS.md` next
to the selected configuration. The Node fix preserves valid JSONC and
unrelated settings.

Inspection does not cover all possible configuration layers. Project settings,
`~/.opencode`, `OPENCODE_CONFIG_DIR` and managed preferences can affect the
effective server. Conflict detection covers only the files stated above.

## File-selection limits

The Node fork bounds glob work in search filters and ignore rules. Limits are
4,096 characters per pattern, 32 brace-alternation levels, 32,768 characters
per matched path, 10,000 rules per effective rule set and 1 MiB per ignore file.
MCP request limits can be stricter.

The matcher yields between work chunks and checks cancellation at checkpoints.
A fixed ceiling bounds counted work for one candidate path. Each match also
has a work cap. Ignore rules, root patterns, request globs and expanded file
types share the candidate allowance. That allowance depends on path length
and the compiled rule weight. The combined rule weight is bounded before
matching starts. These limits do not give a wall-clock time guarantee.

An expensive selection can fail with a limit error. Compilation and limit
errors identify the rule: its ignore-file line, request field and original
index, or source file type. An invalid ignore rule stops the operation; it is
not silently omitted. These protections need no client configuration.

## Cached model integrity

Before reuse, pinned cached artifacts are checked against their expected size
and SHA-256. A matching completion marker does not bypass this check. Valid
cached artifacts work without network access. Corrupt artifacts require a new
download. Verification reads the model files and can take longer on slow storage.
