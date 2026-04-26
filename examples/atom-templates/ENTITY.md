---
id: ENTITY--<ENTITY-NAME>
phase: 2
type: entity
status: draft
vault_id: <YOUR-PROJECT>
title: <Entity name + brief role>
tags: [data-model]
crosslinks:
  used_by: []                   # FEAT-- / ENDPOINT-- that consume this
  related_entities: []          # ENTITY-- with FK / association
---

# ENTITY — <Name>

## Schema

```yaml
fields:
  id:
    type: string                # uuid | string | int | …
    required: true
    description: <semantics>
  created_at:
    type: timestamp
    required: true
  # …
```

## Invariants

- <constraint that must always hold>

## Lifecycle

- created when: ...
- archived when: ...
- never deleted (or: hard-deleted on policy X)

## Indexes

- by `<field>` — used by FEAT-- / ENDPOINT-- ...

## See also

- DB migration: <migration ID>
