# Repository entry point

Google Cloud VM `alesa-personal-assistent/us-central1-a/alesa-vm` (instance ID `7077705867419574607`) is being retired. Do not add replacement processes, cron jobs, agent runs, sandboxes, dependencies, or new workloads there. Until the migration gate passes, retain the existing service only as needed for continuity and use the VM for inventory, export, reconciliation, and shutdown work.

The HH cold-search replacement must run on a separately verified non-GCP host. Cloud Run is not the selected target for HH search. Keep the existing public route and old VM available until the replacement passes the complete migration and scheduled-cycle acceptance in [HH issue #187](https://github.com/trained-assist/trained-assist-hh-skill/issues/187). Other Google services remain permitted when their use does not add workloads to the retiring VM. Plan and status: https://github.com/trained-assist/trained-agent-architecture/issues/145.

Start with README.md and follow the repository-specific contribution and architecture instructions.
