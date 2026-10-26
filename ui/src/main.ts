import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { paintDirt } from './lib/pixel.ts'
import { panel } from './lib/panel.svelte.ts'

paintDirt()
panel.connect()
mount(App, { target: document.getElementById('app')! })
