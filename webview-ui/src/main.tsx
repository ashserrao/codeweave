import { createRoot } from 'react-dom/client';
import { Chat } from './views/Chat';
import { Admin } from './views/Admin';
import { Usage } from './views/Usage';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';

const view = document.body.dataset.view;
createRoot(document.getElementById('root')!).render(view === 'admin' ? <Admin /> : view === 'usage' ? <Usage /> : <Chat />);
