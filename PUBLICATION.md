# Revisión de la edición pública

Fecha: 2026-11-11. Estado: candidata; repositorio público creado, carga del paquete pendiente.

## Alcance

Incluye aportes, triaje de observaciones y evaluación de observación a control,
con sus agentes, motor y pruebas. Excluye el piloto de cola v2, los informes
privados, memorias, transcripciones, registros operativos y el historial Git de
origen. Los registros incluidos son plantillas vacías.

Se reemplazaron las rutas de la máquina y nombres personales en ejemplos, se
asignaron alias a los IDs de observaciones y se retiraron relatos identificables
de incidentes en los archivos revisados. Los manifiestos de distribución tienen
hashes recalculados: no son los identificadores de la edición privada.

## Evidencia y límites

- **231/231 tests focalizados pasan**, cero fallos y cero omitidos: aceptación,
  auditor-result, cobertura, linaje portable, alcance, store, afirmaciones sobre
  tests, trazas Codex, guard de publicación y redacción de secretos.
- Verificador del manifiesto público: `current`, doce artefactos vigentes,
  cero hallazgos.
- Revisión independiente de privacidad y dependencias: no identificó secretos
  reales ni rutas personales en las coincidencias examinadas; se corrigieron los
  relatos de incidentes que señaló. No faltan imports relativos de módulos.
- Los correos `example.invalid`, las rutas de ejemplo y las cadenas de secretos
  sintéticos en los tests son deliberados. No se publican correos personales.
- Esta revisión no demuestra ausencia absoluta de secretos. Los chequeos de
  patrones y la lectura tienen un alcance acotado.
- No se atribuye a esta exportación una suite global verde ni una instalación
  real validada en todos los clientes o sistemas operativos.
- El repositorio de origen permanece privado; no se autoriza cambiar su
  visibilidad ni subir su historial como parte de esta publicación.

## Validación global pendiente

La primera ejecución completa dio 1062 tests: 1035 aprobados, 24 fallidos y
3 omitidos. El control pre-commit bloqueó la publicación; no se considera verde.
Se identificó una dependencia de empaquetado ausente (context-doctor), se agregó
su definición y su prueba de integración específica pasó (1/1). Esa corrección
no equivale a repetir ni aprobar toda la suite.

Entre los fallos restantes observados hay operaciones de enlaces/junctions y
clones de fixtures rechazadas por el entorno, además de un test que necesita
HEAD en el repositorio nuevo aún sin commits. Debe repetirse la suite sobre un
checkout con historial inicial y un entorno que permita esas operaciones antes
de declarar validación global. No se modificaron los tests para ocultar fallos.

## Distribución

Crear un repositorio público independiente y vacío. Publicar exclusivamente los
archivos de esta edición, con historial nuevo y correo Git público noreply.
Verificar el inventario remoto antes de anunciar disponibilidad. Nunca agregar
archivos de la carpeta de preparación, logs de validación o metadatos `.git`
como archivos del paquete.
