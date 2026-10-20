### 1. Detect available models

List the models you can delegate to from the model catalog (**Delegate** in the [host capabilities](../poteto-mode/references/host-capabilities.md)). That list is the dependable source. Record each model's exact identity and the thinking levels it offers. If you cannot list any, ask the user to paste the exact model ids they have access to. Never write a model you have not confirmed is available. The aliases `inherit-parent` and `auto` mean the parent chat's model; they are valid when that model is in the detected set (a terminal allowlist may exclude it).
