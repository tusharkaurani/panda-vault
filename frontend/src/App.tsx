import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Landing from "./pages/Landing";
import CollectionView from "./pages/CollectionView";
import Search from "./pages/Search";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import { api } from "./api";

export default function App() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  async function checkAuth() {
    try {
      const res = await api.auth.status();
      setAuthorized(res.authorized);
    } catch {
      setAuthorized(false);
    }
  }

  useEffect(() => {
    checkAuth();
  }, []);

  if (authorized === null) return null;
  if (!authorized) return <Login onSuccess={checkAuth} />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/c/:collectionId" element={<CollectionView />} />
        <Route path="/search" element={<Search />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </Layout>
  );
}
