# Crypto Intelligence AI

Plataforma educativa de análisis de criptomonedas: panel con datos reales, análisis técnico (RSI, MACD, medias móviles, volatilidad, soportes/resistencias), explorador, asistente de IA en español y simulador con saldo ficticio. No ejecuta operaciones reales ni pide claves de billeteras.

## Requisitos
- Node.js 20 o superior
- Una clave de la API de Anthropic (para el asistente): https://console.anthropic.com
- Conexión a internet (CoinGecko y CoinDesk; la clave de CoinGecko es opcional)

## Puesta en marcha
```
npm install
cp .env.example .env     # edita .env y pega tu ANTHROPIC_API_KEY
npm start
```
Abre http://127.0.0.1:3000

## Arquitectura
- `server.js`: backend Express. Consulta CoinGecko/CoinDesk con caché (30 s precios, 5 min históricos), llama a la API de Anthropic y guarda preferencias y simulaciones aisladas por navegador en SQLite (`data.db`). Las claves viven solo en `.env`.
- `lib/indicators.js`: indicadores técnicos puros (`npm test` los prueba).
- `public/index.html`: interfaz (Chart.js por CDN).

## Datos y frescura
- Cada respuesta incluye la hora de recepción; la barra superior marca "DESACTUALIZADO" si pasan más de 120 s o si CoinGecko falla (se sirve caché marcada como antigua).
- El simulador bloquea operaciones si los precios están desactualizados.
- El asistente recibe precios, análisis calculado y titulares antes de cada respuesta, y muestra fuentes y hora de consulta.

## Límites conocidos
- "Proyectos nuevos": la lista de monedas nuevas de CoinGecko es de pago; se ofrece "En tendencia" (más buscadas) como alternativa.
- El explorador analiza las 50 monedas de mayor capitalización.
- El plan gratuito de CoinGecko limita las peticiones; la caché lo mitiga. Si ves errores 429, añade `COINGECKO_API_KEY`.
- Acceso público sin cuentas. Las preferencias y el simulador son compartidos por todos los visitantes; no guardes información personal.
- Protección básica contra abuso: límite general por IP (90 solicitudes/minuto), escrituras limitadas, asistente limitado a 5 consultas/minuto y 30/hora por IP, y máximo 2 solicitudes de IA simultáneas. Estos límites reducen abuso, pero no sustituyen cuotas y alertas de gasto del proveedor.
- En Render el servidor escucha en `0.0.0.0` y utiliza la IP reenviada por el proxy para aplicar los límites.
- **Persistencia:** SQLite guarda el simulador y las preferencias en `data.db`. El sistema de archivos de los servicios gratuitos de Render es efímero; los datos pueden perderse al reiniciar o volver a desplegar. Para conservarlos se necesita un disco persistente o una base de datos externa compatible.
- **Costos:** publicar la web no vuelve gratuita la API de Anthropic. Las consultas al asistente consumen la cuota/crédito de la clave configurada. Establece límites de gasto en Anthropic y no publiques nunca la clave en GitHub ni en el frontend.
