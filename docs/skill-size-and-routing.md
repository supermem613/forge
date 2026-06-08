# Agent instruction size and routing

Forge skills should be lean dispatchers that point to runbooks, docs, and scripts instead of embedding long operational playbooks.

Keep instructions focused on:

1. The trigger.
2. The required files to read.
3. The command sequence to run.
4. The output contract.

Put long examples or domain-specific procedures in referenced docs owned by the relevant module.
