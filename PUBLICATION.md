# Revision de la edicion publica

Fecha: 2026-11-11. Estado: publicada en la rama predeterminada public-release.
Repositorio: https://github.com/Denver2828/gentle-contribution-skills

## Alcance y privacidad

Incluye aportes, triaje de observaciones y evaluacion de observacion a control,
sus agentes, motor, esquemas, pruebas y la definicion auxiliar de context-doctor.
Excluye el piloto v2, informes privados, memorias, transcripciones, registros
operativos y el historial Git original. Los registros de uso son plantillas.

Se reemplazaron rutas y nombres personales en ejemplos, se asignaron alias a los
IDs de observaciones y se retiraron relatos identificables de incidentes en los
archivos revisados. Los manifiestos se recalcularon para la distribucion.

La revision independiente y el escaneo acotado del inventario de 214 archivos no
identificaron secretos reales ni correos personales. Los ejemplos bajo
example.invalid y las cadenas de secretos en pruebas son sinteticos. El nuevo
historial utiliza correo Git noreply. Esto no demuestra ausencia absoluta de
secretos: el escaneo de patrones y la lectura tienen un alcance limitado.
El repositorio de origen permanece privado.

## Evidencia verificable

Snapshot de codigo probado: 7d90cbef5c473fd59747c46e87fce4c097724436.
[Validacion y publicacion](https://github.com/Denver2828/gentle-contribution-skills/actions/runs/43114681902).

Comando: node --test .claude/tools/audit/test/*.test.mjs

| Entorno | Tests registrados | Aprobados | Fallidos | Omitidos |
|---|---:|---:|---:|---:|
| GitHub Actions Linux, Node 24 | 1055 | 1054 | 0 | 1 |
| GitHub Actions Windows, Node 24 | 1055 | 1054 | 0 | 1 |

- Linux omitio un diagnostico de indice Git de solo lectura: el sistema permite
  reemplazar un archivo 0444 segun los permisos del directorio.
- Windows omitio el caso de nombre no UTF-8 porque el sistema no permite crear
  ese nombre. El comportamiento ante dicho nombre no fue probado en Windows.
- Ambos entornos aprobaron el verificador del manifiesto de distribucion.
- Localmente pasaron 231 pruebas focalizadas y 20 de historial/hashes.
- Los resultados por plataforma no representan casos distintos que deban sumarse.

La primera ejecucion local dio 1035 aprobados, 24 fallidos y 3 omitidos sobre
1062 registros. Se corrigio la dependencia ausente y se creo un historial nuevo
para las pruebas que requieren HEAD. Las operaciones rechazadas por el entorno
local se comprobaron en los runners indicados, sin ocultar fallos ni cambiar las
aserciones. El comando local de descubrimiento automatico tambien contabiliza
modulos auxiliares; la tabla remota corresponde al patron explicito *.test.mjs.

## Que demuestra y que no

Las suites ejecutan casos del motor: contratos, evidencia, integridad, permisos
de publicacion, continuidad, redaccion y operaciones Git con fixtures.
No certifican que un modelo siga siempre las instrucciones, que todos los
clientes integren igual los hooks, ni que toda operacion real con GitHub funcione.
Tampoco prueban ausencia de errores, aislamiento frente a un actor malicioso,
superioridad sobre otros sistemas ni ahorro de tokens.

El historial publico se creo desde una copia seleccionada, sin importar el
historial privado. La carga inicial uso un bundle verificado por checksum; solo
tras las dos suites exitosas se publico su commit exacto como public-release.
La rama main conserva ese material de arranque para trazabilidad. Los cambios
posteriores de documentacion y CI se distinguen del snapshot probado.
