import balenaSdk from 'balena-sdk'
const balena = balenaSdk.fromSharedOptions()
import iotApi from '@clearblade/iot'
import crypto from 'crypto'
import util from 'util'

const generateKeyPair = util.promisify(crypto.generateKeyPair)
// GCP IoT Client
let iot = null
// Path string to IoT Core registry (project, region, registry) required for IoT functions
let registryPath = ''

/**
 * Provides creation and deletion of ClearBlade IoT Core device and updates balena
 * GCP_PRIVATE_KEY environment var for the device. Uses POST request to create
 * and DELETE to delete. Expects request body with JSON containing
 * {uuid: <device-uuid>, balena_service: <service-name> }.
 */
export async function provision(req, res) {
    try {
        const badBodyCode = 'provision.request.bad-body'
        await balena.auth.loginWithToken(process.env.BALENA_API_KEY)

        // Validate and prepare request contents
        //console.debug('event:', req)
        if (!req || !req.body) {
            throw { code: 'provision.request.no-body' }
        }
        const body = req.body
        if (!body.uuid) {
            throw { code: badBodyCode }
        }

        // Validate device with balenaCloud
        const device = await balena.models.device.get(body.uuid)

        // lookup balena service if name provided
        let service
        if (body.balena_service) {
            const allServices = await balena.models.service.getAllByApplication(device.belongs_to__application.__id)
            for (service of allServices) {
                //console.debug("service_name:", service.service_name)
                if (service.service_name == body.balena_service) {
                    break
                }
            }
            if (!service) {
                throw { code: badBodyCode }
            }
        }

        // Initialize globals for GCP IoT data
        iot = new iotApi.v1.DeviceManagerClient({
            projectId: process.env.PROJECT_ID,
            credentials: JSON.parse(Buffer.from(process.env.CB_SERVICE_ACCOUNT, 'base64').toString())
        })
        registryPath = iot.registryPath(process.env.GCP_PROJECT_ID, process.env.GCP_REGION,
            process.env.GCP_REGISTRY_ID)

        let deviceText = `${body.uuid} for service ${body.balena_service}`
        switch (req.method) {
            case 'POST':
                console.log(`Creating device: ${deviceText}...`)
                await handlePost(device, service, res)
                break
            case 'DELETE':
                console.log(`Deleting device: ${deviceText}...`)
                await handleDelete(device, service, res)
                break
            default:
                throw "method not handled"
        }
    } catch (error) {
        console.warn("Error: ", error)
        // error.code might be an integer
        if (error.code && (
                error.code === balena.errors.BalenaDeviceNotFound.prototype.code
                || error.code === balena.errors.BalenaInvalidLoginCredentials.prototype.code
                || error.code.toString().startsWith('provision.request'))) {
            res.status(400)
        } else {
            res.status(500)
        }
        res.send(error)
    }
}

/**
 * Adds device to ClearBlade IoT registry with new key pair, and sets balena
 * environment vars.
 *
 * service: Service on the balena device for which variables are created. If service
 * is undefined, creates device level environment variables.
 *
 * Throws an error on failure to create the device.
 */
async function handlePost(device, service, res) {
    // generate key pair; we only need the private key 
    const keyPair = await generateKeyPair('ec', {namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem'},
        publicKeyEncoding: { type: 'spki', format: 'pem' }
    })

    const deviceId = `balena-${device.uuid}`
    const gcpDevice = {
        id: deviceId,
        credentials: [{ publicKey: { format: 'ES256_PEM', key: keyPair.publicKey } }]
    }
    await iot.createDevice({ parent: registryPath, device: gcpDevice })

    if (service) {
        await balena.models.device.serviceVar.set(device.id, service.id, 'GCP_PRIVATE_KEY',
                Buffer.from(keyPair.privateKey).toString('base64'))
        await balena.models.device.serviceVar.set(device.id, service.id, 'GCP_CLIENT_PATH',
                `${registryPath}/devices/${deviceId}`)
        await balena.models.device.serviceVar.set(device.id, service.id, 'GCP_DATA_TOPIC_ROOT',
                `/devices/${deviceId}`)
        await balena.models.device.serviceVar.set(device.id, service.id, 'GCP_PROJECT_ID',
                process.env.GCP_PROJECT_ID)
    } else {
        await balena.models.device.envVar.set(device.uuid, 'GCP_PRIVATE_KEY',
                Buffer.from(keyPair.privateKey).toString('base64'))
        await balena.models.device.envVar.set(device.uuid, 'GCP_CLIENT_PATH',
                `${registryPath}/devices/${deviceId}`)
        await balena.models.device.envVar.set(device.uuid, 'GCP_DATA_TOPIC_ROOT',
                `/devices/${deviceId}`)
        await balena.models.device.envVar.set(device.uuid, 'GCP_PROJECT_ID',
                process.env.GCP_PROJECT_ID)
    }

    console.log(`Created device ${deviceId}`)
    res.status(201).send("device created")
}

/**
 * Removes device from ClearBlade IoT registry, and also removes balena environment
 * vars.
 *
 * service: Service on the balena device for which variables are removed. If service
 * is undefined, removes device level environment variables.
 * 
 * Throws an error on failure to delete the device or key pair.
 */
async function handleDelete(device, service, res) {
    const deviceId = `balena-${device.uuid}`
    try {
        await iot.deleteDevice({ name: `${registryPath}/devices/${deviceId}` })
    } catch (error) {
        const notFoundCode = 5
        if (!error.code || error.code != notFoundCode) {
            throw error
        } else {
            console.warn("Device not found in IoT Core registry")
        }
    }

    if (service) {
        await balena.models.device.serviceVar.remove(device.uuid, service.id, 'GCP_PRIVATE_KEY')
        await balena.models.device.serviceVar.remove(device.uuid, service.id, 'GCP_CLIENT_PATH')
        await balena.models.device.serviceVar.remove(device.uuid, service.id, 'GCP_DATA_TOPIC_ROOT')
        await balena.models.device.serviceVar.remove(device.uuid, service.id, 'GCP_PROJECT_ID')
    } else {
        await balena.models.device.envVar.remove(device.uuid, 'GCP_PRIVATE_KEY')
        await balena.models.device.envVar.remove(device.uuid, 'GCP_CLIENT_PATH')
        await balena.models.device.envVar.remove(device.uuid, 'GCP_DATA_TOPIC_ROOT')
        await balena.models.device.envVar.remove(device.uuid, 'GCP_PROJECT_ID')
    }

    console.log(`Deleted device ${deviceId}`)
    res.status(200).send("device deleted")
}
