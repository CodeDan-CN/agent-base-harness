import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../packages/app-ui/src/App';
import { initializeTheme } from '../../../packages/app-ui/src/theme';
import { createWebAgentClient } from './web-agent-client';
import '../../../packages/app-ui/src/styles.css';
import { configureClient } from '../../../packages/app-ui/src/client';

configureClient(createWebAgentClient());
document.documentElement.dataset.client = 'web';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');

initializeTheme();
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
