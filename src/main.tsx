import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { installDemoBridge } from './demo';

if (!window.vault && ['http:', 'https:'].includes(location.protocol)) installDemoBridge();
if (!window.vault) {
  document.getElementById('root')!.textContent = 'The desktop connection could not start. Close Wayfarer and open the original executable again.';
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
}
