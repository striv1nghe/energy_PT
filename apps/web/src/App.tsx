import { useEffect, useState } from 'react';
import Dashboard from './views/Dashboard';
import Login from './views/Login';

export default function App() {
  const [authed, setAuthed] = useState(() => !!localStorage.getItem('energy_token'));

  useEffect(() => {
    const onLogin = () => setAuthed(true);
    const onExpired = () => setAuthed(false);
    window.addEventListener('energy-auth-login', onLogin);
    window.addEventListener('energy-auth-expired', onExpired);
    return () => {
      window.removeEventListener('energy-auth-login', onLogin);
      window.removeEventListener('energy-auth-expired', onExpired);
    };
  }, []);

  return authed ? <Dashboard /> : <Login />;
}
