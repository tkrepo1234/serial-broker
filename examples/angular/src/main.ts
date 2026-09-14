import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';
import { installStandInIfRequested } from './stand-in';

// Does nothing in a production build; see stand-in.ts. In place before the application starts,
// because the library reads navigator.serial when the service's setup() first runs.
installStandInIfRequested();

bootstrapApplication(AppComponent, appConfig).catch((error: unknown) => {
  console.error(error);
});
