import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Landing from "./pages/Landing";
import CollectionView from "./pages/CollectionView";
import GroupChannelsView from "./pages/GroupChannelsView";
import Search from "./pages/Search";
import SourceHome from "./pages/SourceHome";
import SettingsLayout from "./pages/settings/SettingsLayout";
import IntegrationsList from "./pages/settings/IntegrationsList";
import CollectionsSettings from "./pages/settings/CollectionsSettings";
import IntegrationSettings from "./pages/settings/IntegrationSettings";
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
            <Route path="/c/:collectionId/group/:group" element={<GroupChannelsView />} />
            <Route path="/search" element={<Search />} />
            {/* The tabs are routes, so each is its own history entry and its
                own breadcrumb crumb. The detail page is a *sibling*, not a
                child: it has its own header and must not inherit the strip. */}
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="integrations" replace />} />
              <Route path="integrations" element={<IntegrationsList />} />
              <Route path="collections" element={<CollectionsSettings />} />
            </Route>
            <Route path="/settings/integrations/:sourceType" element={<IntegrationSettings />} />
            <Route path="*" element={<Landing />} />
          </Routes>
        </Layout>
        <ToastContainer />
      </NotificationProvider>
    </IntegrationsProvider>
  );
}
