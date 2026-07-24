// Browser entry point for the Fuaran TypeScript reference demo.
//
// Mounts <App> into #fuaran-demo-root (per index.html). <App> owns the host
// state + dispatch loop and renders the authored Fuaran tree through
// <FuaranRenderer> from @fuaran-ui/renderer.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fuaran-ui/renderer/css';

import { App } from './App';
import './index.css';

const container = document.getElementById('fuaran-demo-root');
if (container === null) {
  throw new Error('fuaran-demo-root mount target missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
