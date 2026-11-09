# berat-monitoring
Monitoring Tool and forms for residents, employees, and council of Berat Municipaity for waste management. 

## Pages

- `index.html`: start page (Resident, Employee, BCG / Municipality)
- `employee.html`: behind a PIN; links to the electronic Kobo form and to **Scan paper form**
- `scan.html` + `scan/`: reads a photo of the printed scan sheet on the phone (nothing is uploaded),
  then opens the Kobo form pre-filled for the worker to check and send. The files in `scan/` other
  than `reader.js` are made by `form_scanning/export_for_web.py` in the berat-waste-db repo.

When pages change, bump `VERSION` in `sw.js` and the `?v=` numbers in the `.html` files.
