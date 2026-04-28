---
id: ENTITY--<ENTITY-NAME>
phase: 2
type: entity
status: draft
vault_id: <YOUR-PROJECT>
title: <Entity name + brief role>
tags: [data-model]
crosslinks:
  used_by: []                   # FEAT-- / ENDPOINT-- that consume this (Manual Backlink)
  related_entities: []          # ENTITY-- with FK / association (Peer Link)
  part_of: []                   # MOD-- this entity belongs to (Hierarchical Link)
  references: []                # General references or external schemas
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
