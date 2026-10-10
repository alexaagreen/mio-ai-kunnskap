import { Chat } from "./components/Chat";

export default function Page() {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Mio kunnskapsbase</h1>
          <p className="muted">Spør om rutiner, regler og systemer. Svarene bygger kun på artiklene i kunnskapsbasen.</p>
        </div>
      </header>
      <Chat />
    </main>
  );
}
