# Repository Instructions

## Code Review Guidelines

Apply these guidelines when reviewing changes, including a self-review before delivery.

### Review the Resulting Design

- Read the affected implementation, callers, and shared utilities. Evaluate the complete execution path, not only the added lines.
- Check that the change satisfies the requested behavior and preserves required behavior in affected callers and failure paths.
- Keep changes focused on the requirement and any cleanup necessary to implement it coherently.

### Fix the Responsible Implementation

- Correct behavior where its responsibility belongs. Prefer updating the existing implementation over adding wrappers, overrides, post-processing, or special cases that compensate for its defects.
- Remove superseded branches, helpers, configuration, and state within the affected scope. Keep compatibility paths only for consumers that still require them.
- Reuse existing functions, types, and platform capabilities when their semantics fit. If multiple callers need the same correction, fix the shared implementation and update its callers.
- Keep straightforward local logic local. Extract shared code for a concrete shared responsibility rather than a speculative future use.

### Keep Complexity Justified

- Use the simplest design that meets current requirements and demonstrated failure modes. New abstractions, dependencies, options, and fallback paths must serve a concrete need.
- Maintain one authoritative source for each piece of state. Prefer computing derived values over storing redundant flags or metadata.
- Add fields and properties only for a current consumer or an explicit contract; update the affected types and consumers together.
- Add a lock, hash, identifier, cache, or retry only for an identified need that existing execution, transaction, storage guarantees, or values cannot meet.
- Preserve necessary authorization, input validation, and recovery behavior while simplifying the implementation.

### Verification Policy

- Run `npm run typecheck` for TypeScript changes and `npm run build` before deployment. Check changed `ui/app.js` with `node --check`.
- Do not add test files, test dependencies, or a test suite. Use one-off smoke checks in a temporary directory and remove them afterwards.
- Deployment uses `npm run deploy`. Run `npm run discord:register` only when slash command definitions change; it replaces every registered command.

### Verify and Report

- Follow the verification policy above. Check affected callers and relevant failure paths, and confirm that replaced behavior leaves no stale references.
- During self-review, simplify redundant mechanisms and remove obsolete code before delivery. Report which checks actually ran and any remaining verification gaps.
- In a review-only task, report findings without modifying code unless implementation is also requested.
- Report concrete defects or maintainability problems introduced or materially worsened by the change. Identify the location, affected path or triggering condition, consequence, and simplest appropriate correction.
- For unnecessary complexity, identify the redundant mechanism and the existing or simpler implementation that can meet the requirement.
- Base severity on actual impact. Separate blocking defects from non-blocking improvements; omit speculative concerns, unrelated rewrites, and personal style preferences presented as defects.
