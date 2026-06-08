import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  { path: 'home', loadComponent: () => import('./home/home.component') },
  { path: 'products', loadComponent: () => import('./products/products.component') },
  { path: 'about', loadComponent: () => import('./about/about.component') },
];
