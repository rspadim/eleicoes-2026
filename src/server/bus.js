// Barramento unico de eventos do processo (poller/markets -> api/ws).
// Singleton: todo mundo que importar recebe a mesma instancia.
import { EventEmitter } from 'node:events';

// Evita aviso de listener maximo quando ws + api + replay escutam junto.
export const bus = new EventEmitter();
bus.setMaxListeners(200);

export default bus;
