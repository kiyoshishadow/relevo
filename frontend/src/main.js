// Relevo — arranque del frontend. Punto único de registro de rutas.
import './styles/app.css'
import './styles/motion.css'
import './styles/track-motion.css'
import { render, registerView } from './router.js'
import { session } from './session.js'

import { portalView } from './views/portal.js'
import { trackView } from './views/track.js'
import { loginView } from './views/login.js'
import { dashboardView } from './views/dashboard.js'
import { casesView, caseDetailView } from './views/cases.js'
import { newCaseView } from './views/caseNew.js'
import { clientsView } from './views/clients.js'
import { terminalsView } from './views/terminals.js'
import { coveragesView } from './views/coverages.js'
import { loansView } from './views/loans.js'
import { usersView, auditView, notificationsView } from './views/admin.js'
import { reportsView } from './views/reports.js'

registerView('/', portalView)
registerView('/portal', portalView)
registerView('/track', trackView)
registerView('/login', loginView)

registerView('/dashboard', dashboardView)
registerView('/cases', casesView)
registerView('/cases/new', newCaseView)
registerView('/cases/:id', caseDetailView)
registerView('/clients', clientsView)
registerView('/terminals', terminalsView)
registerView('/coverages', coveragesView)
registerView('/loans', loansView)
registerView('/reports', reportsView)
registerView('/users', usersView)
registerView('/audit', auditView)
registerView('/notifications', notificationsView)

window.addEventListener('hashchange', () => render())
window.addEventListener('DOMContentLoaded', () => {
  // La sesión se verifica al primer render de cada vista protegida; aquí solo
  // amortiguamos la primera pintura con el estado vacío.
  render()
})

export { session }
