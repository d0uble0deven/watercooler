# Watercooler — Repo Migration Plan (Personal → Org GitHub)

> **Status: planned, not yet executed.** Happening a round or two after launch,
> before outside contributors join. Until then the app deploys from the
> original personal repo and nothing here is active.

## The Setup, In One Picture

```
DocMe360/watercooler  (org — SOURCE OF TRUTH)     personal fork/repo (maintainer's)
  main ── what production runs                      main ── maintainer's experimental copy
    ▲  ▲                                              ▲
    │  └── contributors merge PRs here                └── syncs with org main only when
    │                                                     the maintainer chooses to
    └── Azure VM pulls + restarts from here (prod)
```

**Rules of the road:**
- The **org repo's `main` is production.** Whatever lands there is what the Azure VM
  deploys on the next `git pull`.
- **Contributors only interact with the org repo** — via pull requests into `main`.
- The **personal repo is the maintainer's sandbox.** Nothing flows between the two
  repos automatically; the maintainer moves changes deliberately in either direction.
- Deploys are manual and maintainer-run (SSH to the VM → `git pull` → `pm2 restart`).
  Merging a PR does **not** auto-deploy.

---

## Part 1 — Org Admin Setup (one-time ask)

What's needed from the GitHub org owner:

1. **Create a private repo** in the org: `DocMe360/watercooler` (empty — no README,
   no license file; it will be seeded by a push with full history).
2. **Grant the maintainer Admin** on that repo (needed to add the VM's deploy key
   and manage collaborators).
3. *(Optional but recommended once contributors join)* **Protect `main`:**
   Settings → Branches → add rule for `main` → require pull requests before merging.
4. **Add contributors** with Write access as people join the project.

That's the entire ask — everything else below is run by the maintainer.

## Part 2 — Migration Checklist (maintainer runs, ~15 min)

1. **Seed the org repo with full history** (from the Mac, in the project folder):
   ```bash
   git remote add docme git@github.com:DocMe360/watercooler.git
   git push docme main
   ```
2. **Verify the org repo works end-to-end before touching prod:** make a trivial
   commit, push to `docme`, confirm it appears on GitHub.
3. **Give the VM read access** (org repo is private):
   ```bash
   # on the VM — generate a read-only deploy key
   ssh-keygen -t ed25519 -C "watercooler-vm-deploy" -f ~/.ssh/deploy_key -N ""
   cat ~/.ssh/deploy_key.pub
   ```
   Paste the printed public key into GitHub: org repo → Settings → Deploy keys →
   Add deploy key (leave "Allow write access" unchecked). Then teach the VM's git
   to use it:
   ```bash
   # on the VM
   git config --global core.sshCommand "ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes"
   ```
4. **Point prod at the org repo:**
   ```bash
   # on the VM
   cd ~/watercooler
   git remote set-url origin git@github.com:DocMe360/watercooler.git
   git pull        # should succeed — this is the moment of truth
   pm2 restart watercooler && pm2 logs watercooler --lines 15
   ```
   Rollback at any point: `git remote set-url origin <personal repo URL>`.
5. **Set up the personal-branch topology** (maintainer's Mac — optional, personal
   workflow):
   ```bash
   git checkout -b docme-main docme/main   # local bridge branch tracking org main
   ```
   - Personal experiments: commit on `main`, `git push origin main`
   - Pull teammates' work: `git checkout docme-main && git pull`
   - Ship to prod: merge/cherry-pick `main` → `docme-main` → `git push docme` (or PR)
   - Adopt org changes into the personal copy: merge `docme-main` → `main` when desired
6. **Update the contributor doc** ([CONTRIBUTING.md](../CONTRIBUTING.md)) if any
   URLs or steps changed, then share it with contributors.

## Why This Order / Design (context for anyone reviewing)

- **Migrating after launch, not before:** the repo's location has zero effect on the
  running app; switching deploy plumbing right before launch only added risk. The
  real deadline is "before contributors join," not "before users use it."
- **Deploy key over a personal token:** the key grants read-only access to exactly
  one repo, lives only on the VM, and survives personnel/account changes.
- **No auto-deploy on merge (for now):** deploys stay manual so a human verifies
  `pm2 logs` after each restart. CI/CD can come later if the project grows.
- **`.env` never migrates:** secrets live only on the VM and in local dev copies.
  The repo has never contained them (`.gitignore` blocks `.env`).
