# Frozen legacy unknown audit

`r03-private-unknown-audit.js` reads the SHA-verified frozen HH archive,
the separately SHA-verified frozen cron database, and the imported target
snapshot staging. It binds each old `unknown` cron definition to its exact
agent-owned profile and vacancy, includes every linked action execution and
source snapshot in an owner-only receipt, and records the source hashes that
make the audit reproducible. Re-running the same audit is byte-identical;
a changed source or different receipt fails closed.

The public command output gives counts only. The private receipt holds old
job, execution, profile, vacancy and slot references plus hashes of execution
and snapshot payloads, never the payload text. A historical snapshot without
an occurrence-bound accepted receipt cannot establish whether an unknown
dispatch completed. Such jobs get `quarantined_ambiguous`, even if a snapshot
timestamp is nearby. This disposition cannot be passed to the schedule
activation port. No missed slot is replayed and no old snapshot is published.

If a later stopped-disk delta changes either source hash, the audit must be
rerun against that new immutable source and the new receipt reviewed before
any imported schedule activation. This tool has no provider call, timer,
route, or schedule mutation.
