# Gotchas

## Keep runbooks thin

Step files should stay small and delegate mechanics to reusable library or module code. If a step grows large, extract the repeated behavior behind a generic seam.

## Keep bundles append-only

Do not edit completed run bundles in place. Write derived artifacts to sibling locations so prior evidence remains auditable.

## Use module seams

If a domain integration needs custom setup, cleanup, validation, or commands, register those through a module instead of adding domain code to Forge core.
