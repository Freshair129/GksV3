Search GKS memory for relevant knowledge.

Call the `gks_recall` MCP tool with:
- `query`: $ARGUMENTS
- `root`: `.`
- `topK`: 5

Format the results as a numbered list:
1. [score] source — snippet
   path (if available)

If no hits, say: "Nothing found for: $ARGUMENTS"

If $ARGUMENTS is empty, ask the user: "What are you looking for?"
