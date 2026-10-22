import '@blueprintjs/core/lib/css/blueprint.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Playground } from './Playground.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
