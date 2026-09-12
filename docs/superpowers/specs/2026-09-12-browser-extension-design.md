# Browser extension starter

## Scope

Set up VoiceAgent as a Manifest V3 extension for Chrome and Edge. Use React, TypeScript, Tailwind CSS, shadcn/ui, and `@phosphor-icons/react`. Use Bun for dependencies, builds, and tests.

Include a minimal popup and options page. Do not implement voice features, content scripts, remote services, or request browser permissions in this starter.

## Structure

```text
src/
  popup/          Popup HTML and React entry point
  options/        Options HTML and React entry point
  background/     Manifest V3 service worker
  components/ui/  Shared shadcn/ui components
  lib/            Shared utilities
  styles/         Tailwind stylesheet and theme tokens
public/
  manifest.json
  icons/
scripts/
  build.ts
```

Keep shadcn configuration at the repository root. Both React pages share the same stylesheet and UI components. Use Phosphor icons for UI controls. Give icon-only controls accessible names; hide decorative icons from assistive technology. Provide local PNG extension icons in the sizes referenced by the manifest.

## Build

Use Bun's bundler directly rather than an extension framework. Compile Tailwind during the build. Bundle all runtime code and styles locally, without inline scripts, external fonts, or CDN dependencies.

`bun run build` creates a loadable `dist/` directory containing the manifest, HTML pages, bundled assets, icons, and service worker. Resolve generated asset paths relative to the extension. The build replaces only its generated output directory.

## Behavior

The popup identifies VoiceAgent as a starter and provides an Open settings action using the browser extension API. The options page explains that voice configuration is not implemented yet; do not show nonfunctional settings controls.

Keep the service worker minimal, without persistent in-memory state, network requests, or listeners for unimplemented features. No cross-context messaging or storage is needed yet.

Handle a failed settings action with a visible, accessible error message. Use semantic controls with visible keyboard focus. Keep the popup compact and the settings page usable at narrow viewport widths.

## Verification

Provide a TypeScript check and Bun tests that validate the built manifest, required entry points, and referenced extension icons. Confirm the production build succeeds. Document how to load `dist/` as an unpacked extension and rebuild after changes. Report separately whether browser smoke testing was performed.

## Decisions

A plain Bun build keeps the starter aligned with the repository's tooling requirements. An extension framework would add conventions and dependencies that this starter does not need. Firefox support and content scripts remain outside this scope.
