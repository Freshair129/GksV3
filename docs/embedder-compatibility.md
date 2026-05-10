# Embedder Compatibility

> Heads-up for Memory OS layers / Obsidian pairings — pick one model and
> stick to it across every surface that embeds the same vault.

GKS 3.6.0 ships `createNomicEmbedder()` (`nomic-ai/nomic-embed-text-v1.5`,
768-dim, Thai + English) as the default local embedder. That's a great
default — but if your humans browse the same vault through plugins like
**Smart Connections** in Obsidian, you have to make Smart Connections
embed with the same model. This doc explains why.

## Why double-embedding is a trap

Every embedder produces vectors in its own space. Two models that look
"similar enough" almost always disagree on at least one of:

- **Dimension** (768 vs 1024 vs 1536 — vectors aren't even comparable
  shape-wise)
- **Tokenizer** ("Bangkok" gets split into different sub-words → different
  inputs to the encoder)
- **Normalization** (some emit unit vectors, some don't — cosine vs dot
  product results diverge)
- **Training corpus** (Thai-aware vs English-only changes which neighbours
  are "nearest")

If GKS embeds with model A and Smart Connections embeds with model B over
the same vault, you pay:

1. **2× compute** at index time
2. **2× storage** (two vector indices on disk)
3. **Cross-surface incompatibility** — recall from GKS won't match recall
   from the Obsidian sidebar, even on the same note
4. **Drift risk** — re-embed one side without the other and your two
   universes silently disagree

## Smart Connections (Obsidian browse plugin)

Smart Connections lets the user pick the embedding model from a GUI
dropdown. To match GKS's default, set:

> Settings → Smart Connections → Embed Model →
> `TaylorAI/bge-micro-v2` *(closest fit)* or, ideally, the same
> `nomic-embed-text-v1.5` if your version of Smart Connections lists it.

If your Smart Connections build doesn't expose `nomic-embed-text-v1.5`,
prefer the **same dimension + same tokenizer family** over "looks
similar". When in doubt, pin the GKS embedder to whatever Smart
Connections offers — see "Deliberate divergence" below.

## Other browse plugins

Same principle: pick the model that the plugin can run, then configure
GKS to use the matching `EmbedderOptions`. The pairing matters far more
than the absolute quality of either model in isolation.

## Headless / non-Obsidian setups

If no human ever browses this vault through a plugin, the GKS vector
store is independent and you can pick any model you like. The
constraint kicks in the moment a *second* surface starts embedding the
*same content*.

## Deliberate divergence

You may want different models on each side — e.g. an English-tuned model
for human browse and a multilingual model for the agent. That's fine,
but document it:

1. Open an `ADR--` in the project's GKS tree explaining *why* the two
   surfaces use different models
2. Configure both sides explicitly (don't rely on either default)
3. Don't expect cross-surface recall to agree on neighbours — it won't

## Re-embedding after a model swap

When you change the GKS embedder:

```sh
npm run gks re-embed   # rebuild the GKS vector index
```

Then re-index on every browse plugin that's been pointed at the same
content. Skipping the second step is the most common cause of "Smart
Connections returns weird neighbours after upgrading GKS".

## Why GKS doesn't enforce this

GKS is a **storage engine** (ADR-008). It serializes vectors and answers
recall queries — it doesn't know which other tools are pointed at the
same vault, and it shouldn't try to. Coordinating browse-side plugins is
a Memory OS / orchestrator concern (see [`docs/MSP_RELATIONSHIP.md`](./MSP_RELATIONSHIP.md)
and [`SCOPE.md`](../SCOPE.md)).

What GKS *does* enforce: the embedder model name + dimension are pinned
into `VectorManifest.embedder_model` / `dimension`. If you load a vector
store that was built with a different model than the embedder you just
configured, GKS refuses to mix them — `re-embed` is the only path
forward.
