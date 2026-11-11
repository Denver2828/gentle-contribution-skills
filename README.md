# Gentle Contribution Skills

Skills comunitarias para preparar aportes y evaluar observaciones. Proyecto
independiente: no es una publicación oficial de Gentle AI ni de Engram.

## Qué incluye

| Skill | Función |
|---|---|
| `gentle-ai-aporte` | Coordina autor y auditor independientes, congela candidatos, registra evidencia y exige aprobación humana del contenido antes de publicar. El publicador admite issues y comentarios, no creación de PRs. |
| `gentle-ai-observation-triage` | Selecciona observaciones de un proyecto para revisión humana. Solo lectura; declara si la búsqueda fue completa o parcial. |
| `gentle-ai-observation-to-ratchet` | Evalúa una observación seleccionada: evidencia vigente, autoridad, responsable, control que la aplicaría y prueba pertinente. Solo lectura; deriva la implementación a otro flujo. |

Se incluyen los agentes autor/auditor, el motor Node, esquemas, verificadores y
tests. El piloto de cola v2 no forma parte de esta edición.

## Instalación y límites

Requiere Node.js 22 o posterior y Git. Para consultar/publicar en GitHub requiere
GitHub CLI autenticado por el usuario. Los agentes separados y los hooks dependen
de las capacidades y configuración del cliente. La configuración incluida de
hooks es para Claude Code/Bash; no se afirma equivalencia automática en otros
clientes, shells, conectores ni navegador.

1. Trabajar en un clon dedicado de este repositorio como controlador. Mantener el
   repositorio objetivo separado; no ejecutar el auditor sobre el checkout del autor.
2. Leer `.claude/tools/audit/README.md` y la skill correspondiente antes de usarla.
3. Revisar `.claude/settings.json` antes de habilitar sus hooks. Si se integra en
   otro workspace, combinar manualmente su configuración; no sobrescribir permisos.
4. Revalidar las políticas de `.claude/tools/audit/policies/` contra las reglas y CI
   vigentes del repositorio objetivo. Sus citas no se actualizan solas. Un fallo o
   evidencia desconocida no autoriza saltarse el control.
5. Para observaciones, disponer de una fuente de memoria del proyecto que permita
   las lecturas requeridas. Si falta enumeración verificable, declarar el límite
   según la skill. El paquete no incluye memorias del autor ni instala Engram.
6. Las rutas a `gentle-ai-scout`, `skill-improver`, `systemic-issue-triage`,
   `gentle-ai-bench` y RDD describen integraciones externas, no skills incluidas.
   Si la ruta requerida no está instalada, detener esa derivación e informar qué
   falta; no simular su resultado. La instalación de un control ocurre fuera de
   las skills de observaciones.

Ejemplos de solicitudes:

- «Usá gentle-ai-aporte para preparar un issue con esta reproducción; no publiques
  hasta que apruebe el contenido exacto».
- «Usá observation-triage para el proyecto indicado, con fecha de corte UTC explícita».
- «Evaluá esta observación con observation-to-ratchet; indicá prueba y límites».

Los controles son procedimentales y dependen de participantes cooperativos. No
son aislamiento adversarial: quien tiene credenciales puede escribir por otros
canales. La evidencia no equivale a autorización. La firma de recibos es opcional;
su configuración y operación corresponden al humano, en su terminal.
El anclaje de confianza de la firma incluido está implementado para Windows;
no se promete ese mismo anclaje en Linux o macOS.

## Verificación

```sh
node --test .claude/tools/audit/test/*.test.mjs
node .claude/tools/audit/bin/verify-portable-skill-lineage.mjs --manifest .claude/skills/gentle-ai-observation-to-ratchet/references/portable-lineage.v1.json --root .
```

Consultar `PUBLICATION.md` para el alcance de la revisión de esta edición. Una
suite verde demuestra únicamente sus casos ejecutados. No se afirma ausencia de
errores, mayor calidad que otros sistemas ni ahorro de tokens.

## Privacidad de esta edición

Exportación con historial nuevo y archivos seleccionados. No incluye memoria
real, transcripciones, almacenes operativos, configuración local, credenciales,
informes privados ni historial Git del workspace original. Los registros de uso
son plantillas vacías. Los identificadores históricos de observaciones son alias
de distribución: no permiten recuperar memorias privadas. Los hashes de los
manifiestos se recalcularon para estos archivos; no certifican la historia privada.

Los tests contienen datos sintéticos: direcciones bajo `example.invalid`, rutas
de ejemplo y cadenas falsas para probar redacción de secretos. No son cuentas,
credenciales ni ubicaciones del autor. Las rutas relativas son necesarias para
ejecutar las herramientas y no identifican una computadora personal.

No subir los datos de una ejecución a este repositorio. `.gitignore` excluye
estado, claves, configuración local y clones de objetivos; revisá siempre el diff
antes de publicar cambios propios.

## Licencia y atribución

Apache-2.0. Mantener `LICENSE` y `NOTICE`. Parte del criterio del auditor deriva
de `decode2/pr-review-discipline` v1.6; el aviso conserva su atribución y describe
las adaptaciones. Los cambios de esta edición pública están indicados en NOTICE.
