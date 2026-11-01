import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Shell } from './components/shell';
import { AuditScreen, PLANNED, PlannedScreen, SettingsScreen, UsersScreen } from './screens/admin';
import { LogisticsScreen, OrderDetailScreen, OrderingScreen, PaymentDetailScreen, PaymentsScreen, ShipmentDetailScreen } from './screens/apps';
import { LoginScreen, SignupScreen, VerifyScreen } from './screens/auth';
import { CatalogScreen, HomeScreen, ProvisioningScreen } from './screens/platform';
import { DataStudioScreen } from './screens/datastudio';
import { EndpointScreen, HubScreen } from './screens/hub';
import { PosScreen, SaleDetailScreen } from './screens/pos';
import { RecordDetailScreen, RecordsIndexScreen, RecordsScreen } from './screens/records';

const root = createRootRoute({ component: () => <Outlet /> });

const signup = createRoute({ getParentRoute: () => root, path: '/signup', component: SignupScreen });
const login = createRoute({ getParentRoute: () => root, path: '/login', component: LoginScreen });
const verify = createRoute({ getParentRoute: () => root, path: '/auth/verify', component: VerifyScreen });

const app = createRoute({ getParentRoute: () => root, id: 'app', component: Shell });
const r = (path: string, component: () => React.ReactNode) => createRoute({ getParentRoute: () => app, path, component });

const routeTree = root.addChildren([
  signup,
  login,
  verify,
  app.addChildren([
    r('/', HomeScreen),
    r('/catalog', CatalogScreen),
    r('/provisioning/$runId', ProvisioningScreen),
    r('/users', UsersScreen),
    r('/settings', SettingsScreen),
    r('/audit', AuditScreen),
    r('/apps/ordering', OrderingScreen),
    r('/apps/ordering/$id', OrderDetailScreen),
    r('/apps/pos', PosScreen),
    r('/apps/pos/sales/$id', SaleDetailScreen),
    r('/apps/logistics', LogisticsScreen),
    r('/apps/logistics/$id', ShipmentDetailScreen),
    r('/apps/payments', PaymentsScreen),
    r('/apps/payments/$id', PaymentDetailScreen),
    r('/data-studio', DataStudioScreen),
    r('/data', RecordsIndexScreen),
    r('/data/$entity', RecordsScreen),
    r('/data/$entity/$id', RecordDetailScreen),
    r('/integration-hub', HubScreen),
    r('/integration-hub/endpoints/$id', EndpointScreen),
    ...Object.keys(PLANNED).map((path) => r(path, () => <PlannedScreen path={path} />)),
  ]),
]);

// Routes are registered dynamically (planned screens), so links are typed as plain strings.
export const router = createRouter({ routeTree, defaultPreload: 'intent' });


