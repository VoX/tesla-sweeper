import { render } from 'preact';
import App from './App';
import './App.css';

// One-time hygiene: the BFF migration moved Tesla token ownership to the
// server (the SPA used to cache an OAuth token pair here). Drop the stale
// key so it doesn't linger in localStorage on returning visitors.
localStorage.removeItem('tesla_tokens');

render(<App />, document.getElementById('root'));
