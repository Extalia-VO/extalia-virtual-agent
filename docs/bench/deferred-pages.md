# Deferred page loading

The application previously imported all secondary pages into its initial module
graph, including pages not visited during an Office or Chat session. Eleven pages
now load when opened: Settings, Missions, Knowledge, Skills, Observe, History,
Import, Files, Git, Logs and Diagnostics.

Office, Chat, setup and global supervision remain static. A page-only Suspense
boundary displays localized loading status. A failed page leaves navigation,
approvals and observed-input controls mounted. Reload is an explicit user action;
there is no reload loop or automatic replay of prompts.

## Production build measurement

Both builds use the same marketplace feature state and Vite manifest generation.
The measurement follows the HTML entry and every unique recursive static import.
Dynamic imports, CSS, fonts and model assets are excluded. Each JavaScript file is
compressed separately using gzip level 9 or Brotli quality 11, then summed.

| JavaScript scope | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Entry, raw bytes | 1,887,239 | 1,079,447 | 42.80% |
| Entry, gzip bytes | 559,127 | 320,005 | 42.77% |
| Complete static closure, raw bytes | 2,809,998 | 2,437,016 | 13.27% |
| Complete static closure, gzip bytes | 801,832 | 710,785 | 11.35% |
| Complete static closure, Brotli bytes | 648,830 | 584,046 | 9.98% |

All eleven deferred page modules appear as dynamic entries in the production
manifest. The complete static closure is the relevant initial-transfer comparison;
the entry alone excludes shared chunks that still load at startup.

These results establish reduced initial JavaScript transfer. They do not measure
Desktop memory, JavaScript parse time, model latency, Office FPS or low-spec
hardware. Navigating to a deferred page adds its first on-demand fetch; subsequent
visits reuse the loaded module. Runtime/device measurements remain a separate
acceptance gate.

Focused tests cover pending and resolved lazy pages, cached modules, localized
loading/error UI and explicit recovery. Full-App browser acceptance is tracked in
the product PRD. Local measurement and synthetic browser artifacts are kept under
the ignored `output/page-loading/` directory.
