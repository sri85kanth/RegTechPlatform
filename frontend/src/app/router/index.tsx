import { useEffect } from 'react';
import { createBrowserRouter, Navigate, useParams } from 'react-router-dom';
import { AppShell } from '@/layouts/AppShell';
import { OverviewPage } from '@/modules/overview/OverviewPage';
import { DashboardPage } from '@/modules/overview/DashboardPage';
import { EntityListPage } from '@/modules/EntityListPage';
import { CompanyGraphPage } from '@/graph/CompanyGraphPage';
import { RegulationDetailPage } from '@/modules/regulatory/RegulationDetailPage';
import { RegulationsListPage } from '@/modules/regulatory/RegulationsListPage';
import { IngestionPage } from '@/modules/regulatory/IngestionPage';
import { RegulationImpactPage } from '@/modules/impact/RegulationImpactPage';
import { UsersPage } from '@/modules/admin/UsersPage';
import { WorkspacesPage } from '@/modules/admin/WorkspacesPage';
import { GovernancePage } from '@/modules/governance/GovernancePage';
import { RiskSetupPage } from '@/modules/risk/RiskSetupPage';
import { RiskReviewPage } from '@/modules/risk/review/RiskReviewPage';
import { useUi } from '@/app/store/ui';
import { CompliancePage } from '@/modules/compliance/CompliancePage';
import { AppliesToUsPage } from '@/modules/compliance/AppliesToUsPage';
import { ControlsPage } from '@/modules/compliance/ControlsPage';
import { KnowledgePage } from '@/modules/knowledge/KnowledgePage';
import { AddDataPage } from '@/modules/onboarding/AddDataPage';
import { CompanySetupPage } from '@/modules/onboarding/CompanySetupPage';
import { StructurePage } from '@/modules/onboarding/StructurePage';
import { DepartmentsPage } from '@/modules/departments/DepartmentsPage';
import { DepartmentPage } from '@/modules/departments/DepartmentPage';
import { CascadePage } from '@/modules/cascade/CascadePage';
import { AuditorAccessPage } from '@/modules/auditor/AuditorAccessPage';
import { AuditorPreviewPage } from '@/modules/auditor/AuditorPortal';
import { IntakeBatchPage } from '@/modules/intake/IntakeBatchPage';
import { RouteError } from './RouteError';

function RedirectRegulation() {
  const { id = '' } = useParams();
  return <Navigate to={`/regulation/${encodeURIComponent(id)}`} replace />;
}

/** An old /entity/:id link opens the record drawer over the overview instead. */
function RedirectEntity() {
  const { id = '' } = useParams();
  const open = useUi((s) => s.openEntity);
  useEffect(() => { if (id) open(id); }, [id, open]);
  return <Navigate to="/overview" replace />;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    // a crash in the shell itself; a crash in a page is caught below, inside the shell
    errorElement: <RouteError />,
    children: [{
      // pathless: a page that crashes shows RouteError with the sidebar still there
      errorElement: <RouteError />,
      children: [
      // Landing on the dashboard, not on Overview: the first screen should say
      // what changed and what needs attention, not describe the record.
      { index: true, element: <DashboardPage /> },
      { path: 'overview', element: <OverviewPage /> },
      { path: 'overview/:subtab', element: <OverviewPage /> },
      // org chart of the departments (same data as /departments, drawn as a tree)
      { path: 'graph', element: <CompanyGraphPage /> },
      { path: 'departments', element: <DepartmentsPage /> },
      { path: 'departments/:nodeId', element: <DepartmentPage /> },
      { path: 'structure', element: <StructurePage /> },
      { path: 'company-setup', element: <CompanySetupPage /> },
      // Add data: Connections, Documents and Spreadsheet import as tabs of one page.
      // The three pages it replaced in the nav redirect to their tab.
      { path: 'add-data', element: <AddDataPage /> },
      { path: 'add-data/:tab', element: <AddDataPage /> },
      { path: 'onboarding', element: <Navigate to="/add-data/import" replace /> },
      { path: 'integrations', element: <Navigate to="/add-data" replace /> },
      { path: 'intake', element: <Navigate to="/add-data/documents" replace /> },
      { path: 'intake/:id', element: <IntakeBatchPage /> },
      { path: 'knowledge', element: <KnowledgePage /> },
      { path: 'compliance', element: <CompliancePage /> },
      { path: 'controls', element: <ControlsPage /> },
      { path: 'applies', element: <AppliesToUsPage /> },
      { path: 'cascade', element: <CascadePage /> },
      { path: 'governance', element: <GovernancePage /> },
      { path: 'risk-setup', element: <RiskSetupPage /> },
      { path: 'risk-setup/:tab', element: <RiskSetupPage /> },
      { path: 'risk-review', element: <RiskReviewPage /> },
      { path: 'risk-review/:tab', element: <RiskReviewPage /> },
      { path: 'users', element: <UsersPage /> },
      { path: 'workspaces', element: <WorkspacesPage /> },
      // external auditors: what each one sees (an auditor's own portal is AppShell → AuditorShell)
      { path: 'auditor-access', element: <AuditorAccessPage /> },
      { path: 'auditor-access/preview/:uid', element: <AuditorPreviewPage /> },
      { path: 'auditor', element: <Navigate to="/auditor-access" replace /> },
      { path: 'reg-regulations', element: <RegulationsListPage /> },
      { path: 'ingestion', element: <IngestionPage /> },
      { path: 'regulation/:id', element: <RegulationDetailPage /> },
      { path: 'regulation/:id/impact', element: <RegulationImpactPage /> },
      // Removed views. Old bookmarks land on the page that replaced each one.
      //   review / settings / actions / impact-engine: placeholders or unused, no live data
      //   search: substring match over company records only — Knowledge Search covers both corpora
      //   activity: same feed as Overview › Activity
      //   regulation/:id/detail: a second regulation page; /regulation/:id is the one
      //   entity/:id: duplicated the record drawer every list opens
      { path: 'review', element: <Navigate to="/" replace /> },
      { path: 'settings', element: <Navigate to="/users" replace /> },
      { path: 'actions', element: <Navigate to="/compliance" replace /> },
      { path: 'impact-engine', element: <Navigate to="/cascade" replace /> },
      { path: 'search', element: <Navigate to="/knowledge" replace /> },
      { path: 'activity', element: <Navigate to="/overview/activity" replace /> },
      { path: 'mapping', element: <Navigate to="/reg-regulations" replace /> },
      { path: 'regulation/:id/detail', element: <RedirectRegulation /> },
      { path: 'entity/:id', element: <RedirectEntity /> },
      // config-driven domain routes — one page renders all Company Brain domains.
      // Static routes above take precedence over the :domain param in React Router.
      { path: ':domain', element: <EntityListPage /> },
      { path: ':domain/:subtab', element: <EntityListPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
      ],
    }],
  },
]);
