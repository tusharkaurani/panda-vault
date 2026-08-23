import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Landing from "./pages/Landing";
import CollectionView from "./pages/CollectionView";
import Search from "./pages/Search";
import SourceHome from "./pages/SourceHome";
import Settings from "./pages/Settings";
import { IntegrationsProvider } from "./integrations/IntegrationsContext";
import { NotificationProvider } from "./notifications/NotificationContext";
import ToastContainer from "./notifications/ToastContainer";

// Telegram used to gate the entire app: <Login> rendered *instead of* the
// router until a session existed. It no longer does. Telegram is one
// integration among several, and an install that only uses M3U playlists
// has no Telegram account to sign in with — so the app always renders, and
// connecting Telegram is a task in Settings → Integrations like any other.
export default function App() {
  return (
    <IntegrationsProvider>
      <NotificationProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/s/:sourceType" element={<SourceHome />} />
            <Route path="/c/:collectionId" element={<CollectionView />} />
            <Route path="/search" element={<Search />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Landing />} />
          </Routes>
        </Layout>
        <ToastContainer />
      </NotificationProvider>
    </IntegrationsProvider>
  );
}
