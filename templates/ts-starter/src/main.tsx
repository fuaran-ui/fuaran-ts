// Browser entry point.
//
// Mounts <App> into #fuaran-app-root (per index.html) and imports the renderer's
// reference stylesheet. <App> owns the host state + dispatch loop and renders
// the authored Fuaran tree through <FuaranRenderer>.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fuaran-ui/renderer/css';

import { App } from './app';

const container = document.getElementById('fuaran-app-root');
if (container === null) {
  throw new Error('fuaran-app-root mount target missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
