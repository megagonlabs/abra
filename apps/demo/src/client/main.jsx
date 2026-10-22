import { FocusStyleManager } from '@blueprintjs/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
// Blueprint base styles first, then our tokens + shell styles so ours win on conflict.
import '@blueprintjs/core/lib/css/blueprint.css';
import '@blueprintjs/icons/lib/css/blueprint-icons.css';
import './theme.css'; // design tokens — must load before styles.css
import './styles.css';

FocusStyleManager.onlyShowFocusOnTabs(); // hide focus rings except on keyboard nav

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
